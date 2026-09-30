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

`inspectKey` performs a direct lookup of a **flat entry key** in each layer. It does not traverse nested objects or compute deep-merged object values: the last layer containing that exact key wins, even if its value is `undefined`. `resolveConfiguration` deep merges entries and skips `undefined` for provenance. Neither public helper enforces schema override ceilings or provides governed service inspection; ceiling enforcement is separate work.

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
