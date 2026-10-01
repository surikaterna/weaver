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

Validators inspect own descriptors before reading schemas, configuration values, options, or path arrays. Own accessors (including hidden and nested metadata accessors), symbols and executable data fail with the existing typed validation-result categories without invoking input getters. Inherited fields never supply schema types, defaults, constraints, branches, properties, or tuple members. Structural schema arrays use their own semantic slots; absent tuple declarations cannot be filled by prototype data. Standard Object/Array numeric prototype accessors cannot intercept internal validation scratch or error/path arrays.

Caller **schema** nodes, maps and structural arrays are own-field contracts: an unrelated custom prototype or intrinsic brand alone does not reject otherwise valid own schema fields. Prototype getters, `Symbol.toStringTag`, and inherited iterators are not read to interpret schemas. This exemption does not apply to configuration values, options/path data, or literal `default`/`const`/`enum`/example payloads, whose plain-data restrictions remain in force. Registry registration retains its separate, stricter admission contract; validator success neither registers schemas nor grants access.

Validation does not clone, freeze, or mutate callers. Call-local preparation retains original schema identities and checks descriptor/prototype/extensibility changes before reuse; custom schema prototypes may conservatively disable cache reuse without invalidating admission. Graph inspection and validation worklists are iterative and support acyclic sharing without arbitrary depth limits. These guarantees assume standard intrinsics, not a hostile same-realm sandbox or side-effect-free Proxy reflection.

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

Snapshots expose only detached deeply frozen `entries` and ordered raw `layers`. Provenance is a private compact DAG with cached single-origin/mixed summaries, held in a WeakMap keyed by the exact engine-issued snapshot object. `inspectResolvedPath` rejects cloned, schema-parsed, JSON-roundtripped or forged objects with `VALIDATION_ERROR` before reading their fields. Schemas validate inert data DTOs, not inspection handles or authority. Hosts retain the issued handle per immutable revision; there is no expanded public `trace`, trace schema, or provenance import API. Data can be serialized subject to ordinary JSON limitations; reconstructing an inspection handle is deliberately unsupported. This supersedes the expanded trace design of this unmerged pre-1 API.

All value copying, merge frames, policy compilation, origin summaries and freezing use iterative worklists. Acyclic value aliases are preserved without caller aliases or caller freezing. Merge memoization includes insertion/base identity, prior provenance, current provider/layer and canonical residual ceiling context. Aliases under different policies may legitimately split. Complexity follows value edges plus distinct merge/policy-context edge work and policy-plan size, **not** expanded leaf paths or an unconditional globally-unique-object bound across different contexts. Inspection walks only the requested path in the issued values/private provenance and each raw layer, using cached summaries for objects without enumerating their subtrees or merging again.

Defined equal-valued overrides change origin; object inspection has a single effective layer/provider only when all surviving origins agree. Arrays are atomic, including inspection of their present children. Undefined skips an ordinary merge operation, but own nested undefined remains present on first object insertion, matching legacy deep merge.

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

const contract = deriveContractFromPackageJson({ name: "@example/panel-plugin" });
// namespace: "example.panel", version: "0.0.0", description: ""
// weaver.configNamespace can explicitly override the derived namespace.
const composed = composeConfigurationSchemas([{
  ownerId: contract.pluginId,
  namespace: contract.namespace,
  properties: { "display.limit": { type: "integer", minimum: 1, default: 25 } },
}]);
if (composed.errors.length === 0) {
  const jsonSchema = generateJsonSchema(composed.schemas, { title: "Configuration panel" });
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
## Contextual public-data projection

`projectConfigurationData(value, context, visitor)` preflights and detaches plain
data before invoking trusted library callbacks. `decide` returns `retain`, `omit`,
or `descend`; `child` supplies a structural-policy context for each own field.
Traversal is iterative, with memoization by **object and context**, not object
identity alone. Returned graphs are frozen. Omitted array positions remain holes
without shifting indices; JSON encodes those holes as neutral `null` values.
The optional `preserveUndefinedArraySlots` callback setting exists only to retain
the legacy server representation of omitted positions as own `undefined` slots.
`mutableContainers` preserves its mutable descended containers; retained terminal
data remains detached and guarded. Neither compatibility setting grants access,
and registered reads use neither setting.

`createMountSourceClassifier(state, sourceIsForbidden, cycleIsForbidden)` follows
own mount-source chains using the existing storage-path codec. The state must
already be preflighted by its adapter. It never evaluates mounts or resolves
secrets. Registered adapters fail closed on cycles; compatibility adapters may
retain the historical cycle outcome. `isProtectedConfigPath` preserves the
historical lexical/logical protected-root checks; it is not a canonical registry
path validator or a sensitivity policy.

The visitor and classifier are executable composition interfaces, not permissions
or serializable capabilities. `configurationProjectionActionSchema` validates
the serializable action vocabulary; parsing data does not authenticate callbacks.

### Extraction ownership

The server's former value projection now delegates to `public-data-projection`.
Its mount-chain loop delegates to `mount-source-classification`, whose private
`projection-data` module owns descriptor-only source lookup and marker reads.
Protected lexical/logical checks live in `protected-config-paths`; mutation error
formatting, scope/delta handling, and inspection assembly stay in server adapters.
The resolution, merge, and provenance implementations are unchanged.
### Native snapshot/path contracts

Snapshot schemas and `canonicalConfigPathSchema` use co-located native Zod
contracts after descriptor-first detached capture. Their native contracts are
available through `.out`; readonly containers expose `unwrap` and object schemas
expose `.shape`. Input/output types and wire fields retain their meaning. Snapshot
body records are preserved intact, including inert own reserved names, rather
than passed through a lossy record parser. Canonical root and trailing-slash
behavior remains distinct from stricter service paths; `parsePath` and `buildPath`
remain the sole storage codec. Schema parsing never issues or authenticates a
resolution snapshot. Native Zod runs under standard JavaScript prototypes, not
an executable ambient-prototype sandbox.
