# @weaver-conf/config-engine

> Deep merge, layer resolution, key inspection, scope chains, schema registry, and codegen for Weaver configuration.

## Installation

```bash
pnpm add @weaver-conf/config-engine
```

## Overview

`@weaver-conf/config-engine` is the resolution core of the Weaver configuration system. It takes a stack of configuration layers and produces a single resolved output via deep merge. Provenance records the last layer supplying each top-level entry, not the origin of each nested leaf.

The package root also provides contract metadata derivation, bracket-aware namespace/key utilities, a schema registry for aggregating property declarations across modules, and codegen utilities for generating JSON Schema and Zod source from composed property schemas.

### Schema composition validation

The configuration validators support `anyOf`, `oneOf`, `allOf`, and `not` at every schema location. Composition keywords, ordinary sibling constraints, and multiple composition keywords on the same schema are conjunctive. Failed branches remain private; callers receive one summary error for each failed composition keyword.

Partial validation does not apply defaults or enforce `required` and `minProperties`. Effective validation uses root and branch defaults as nonmutating fallbacks, so defaults can make multiple `oneOf` branches match without changing or persisting the input.

Patch validation fully checks composition on the resolved leaf. At unknown ancestor context it conservatively defers `anyOf`, `oneOf`, and `not`, while retaining direct and `allOf` structural constraints. Registered server writes always validate the fully patched candidate before storage mutation, which remains authoritative for sibling-dependent composition.

## Usage

### Deep merge

```typescript
import { deepMerge } from "@weaver-conf/config-engine";

const base = { theme: { color: "blue", font: "sans" }, debug: false };
const override = { theme: { color: "red" }, debug: true };

deepMerge(base, override);
// => { theme: { color: "red", font: "sans" }, debug: true }
```

Merge rules: objects deep merge, arrays replace, primitives replace, `null` clears, `undefined` skips.

### Resolving a layer stack

```typescript
import { resolveConfiguration, inspectKey } from "@weaver-conf/config-engine";

const stack = {
  layers: [
    { layer: "core", entries: { "app.ui.theme": "light" } },
    { layer: "tenant", entries: { "app.ui.theme": "dark" } },
    { layer: "user", entries: { "app.ui.fontSize": 14 } },
  ],
};

const resolved = resolveConfiguration(stack);
resolved.entries;    // { "app.ui.theme": "dark", "app.ui.fontSize": 14 }
resolved.provenance; // Map { "app.ui.theme" => "tenant", "app.ui.fontSize" => "user" }

const inspection = inspectKey(stack, "app.ui.theme");
inspection.effectiveValue; // "dark"
inspection.effectiveLayer; // "tenant"
inspection.layerValues;    // { core: "light", tenant: "dark" }
```

`inspectKey` performs a direct lookup of a **flat entry key** in each layer. It does not traverse nested objects or compute deep-merged object values: the last layer containing that exact key wins, even if its value is `undefined`. `resolveConfiguration` deep merges entries and skips `undefined` for provenance. These legacy helpers do not enforce override ceilings; use the snapshot API for nested resolution and inspection.

### Immutable nested resolution snapshots

```typescript
import { resolveConfigurationSnapshot, inspectResolvedPath } from "@weaver-conf/config-engine";

const snapshot = resolveConfigurationSnapshot({
  configuredRanks: [0, 1],
  ceilings: [{ path: ["cfg", "locked"], maxRank: 0 }],
  layers: [
    { layer: "core", providerId: "defaults", rank: 0, entries: { cfg: { locked: 1, a: 1 } } },
    { layer: "user", providerId: "preferences", rank: 1, entries: { cfg: { locked: 9, b: 2 } } },
  ],
});
inspectResolvedPath(snapshot, ["cfg", "locked"]).effectiveLayer; // "core"
inspectResolvedPath(snapshot, ["cfg"]).effectiveLayer; // undefined: composite origins
```

Paths are literal segment arrays (a dot inside a segment is not a separator). Ranks must be finite configured positions; layer array order determines precedence, including repeated slots from different providers. Duplicate layer/provider pairs are rejected. Ancestor ceilings tighten descendants; a child cannot loosen its parent. Allowed object siblings survive pruning. Atomic arrays, null and primitives cannot replace an ancestor of any blocked declared descendant, even when that descendant is currently absent.

The engine consumes a host-compiled ceiling plan, not schemas or authorization. `trustedEmergency: true` is a **trusted host capability**, never a caller role or an automatic property of a session layer. Hosts must validate emergency eligibility separately. It does not authorize writes, reveal sensitive data, or bypass registry, role or session policy.

Snapshots descriptor-copy plain data before resolution, reject accessors without invoking getters, cycles, symbols and custom object/array prototypes, and accept acyclic sharing/null-prototype records. Enumerable own data names including `__proto__`, `constructor`, and `prototype` survive as inert own properties, never inherited reads or setter assignments. Direct inspection requests and ceiling input paths still reject these reserved segments; literal trace/result tuples may describe reserved children inside an allowed parent. They are data metadata, not access authority. Throwing proxy reflection fails typed; proxy trap execution cannot be guaranteed side-effect-free.

Values, ordered raw contributions and surviving trace records are detached and deeply frozen. Inspection uses the same generation without I/O or a second merge and validates externally supplied snapshot descriptors before reading them. Defined equal-valued overrides change origin; object inspection has a single effective layer/provider only when all surviving origins agree. Arrays are atomic, including inspection of their present children. Undefined skips an ordinary merge operation, but own nested undefined remains present on first object insertion, matching legacy deep merge.

Co-located exported Zod schemas preflight descriptors and preserve own data keys through parsing rather than reconstructing entries with a lossy record parser. They validate data/structure, not permission or authentication; the resolver additionally enforces rank/duplicate constraints. Opaque `merge` strategies are rejected with `UNSUPPORTED_OPERATION` before executing a callback. Legacy `resolveConfiguration` custom merge identity/order/count remain unchanged; the private legacy ceiling helper now retains custom callbacks when filtering entries but remains unexported. Arbitrary custom merge provenance is not promised.

### Schema registry

```typescript
import { createSchemaRegistry } from "@weaver-conf/config-engine";

const registry = createSchemaRegistry();
registry.register({
  ownerId: "my-plugin",
  namespace: "app.myPlugin",
  properties: {
    "display.maxItems": { type: "number", defaultValue: 25 },
  },
});

registry.getSchema("app.myPlugin.display.maxItems");
```

### Namespace utilities

```typescript
import { qualifyKey, validateKeyFormat, deriveNamespace } from "@weaver-conf/config-engine";

qualifyKey("app.vesselView", "map.defaultZoom"); // "app.vesselView.map.defaultZoom"
validateKeyFormat("app.vesselView.map.defaultZoom"); // { valid: true }
deriveNamespace("@weaver-conf/vessel-view-plugin"); // "weaverConf.vesselView"
```

### Contract metadata and flat schema generation

```typescript
import {
  deriveContractFromPackageJson, composeConfigurationSchemas,
  generateJsonSchema, generateZodSchemaSource,
} from "@weaver-conf/config-engine";

const contract = deriveContractFromPackageJson({ name: "@ghost/panel-plugin" });
// namespace: "ghost.panel", version: "0.0.0", description: ""
// weaver.configNamespace can explicitly override the derived namespace.
const composed = composeConfigurationSchemas([{
  ownerId: contract.pluginId,
  namespace: contract.namespace,
  properties: { "display.limit": { type: "integer", minimum: 1, default: 25 } },
}]);
if (composed.errors.length === 0) {
  const jsonSchema = generateJsonSchema(composed.schemas, { title: "Ghost panel" });
  const zodSource = generateZodSchemaSource(composed.schemas);
}
```

Generators take a `Map<string, ComposedSchemaEntry>`, not raw property schemas. JSON Schema retains flat fully-qualified property names rather than constructing nested namespace objects. Zod generation returns TypeScript source with sanitized named schemas and a flat `configSchemas` lookup; it is not a complete JSON Schema compiler (for example, union types use the first type and composition keywords are not translated). Use the canonical validators for authoritative admission.

## API Reference

| Export | Description |
|---|---|
| `deepMerge(base, override)` | Deep merge two config objects |
| `resolveConfiguration(stack)` | Resolve a layer stack into merged entries + provenance |
| `inspectKey(stack, key)` | Inspect an exact flat entry key across layers |
| `createSchemaRegistry()` | Create an incremental schema registry |
| `composeConfigurationSchemas(declarations)` | One-shot schema composition |
| `qualifyKey(namespace, relativeKey)` | Join namespace + key with dot separator |
| `validateKeyFormat(key)` | Validate one or more bracket-aware alphanumeric segments starting with a letter |
| `deriveNamespace(pluginId)` | Derive namespace from package/plugin ID |
| `deriveContractFromPackageJson(pkg)` | Derive package identity, namespace, version, and description |
| `generateJsonSchema(schemas, options?)` | Generate flat JSON Schema from composed entries |
| `generateZodSchemaSource(schemas)` | Generate TypeScript Zod source from composed entries |

## License

MIT
