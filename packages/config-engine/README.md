# @weaver-conf/config-engine

> Deep merge, layer resolution, key inspection, scope chains, schema registry, and codegen for Weaver configuration.

## Installation

```bash
pnpm add @weaver-conf/config-engine
```

## Overview

`@weaver-conf/config-engine` is the resolution core of the Weaver configuration system. It takes a stack of configuration layers and produces a single resolved output via deep merge, with full provenance tracking (which layer set each key).

The package also provides namespace utilities for the `{namespace}.{category}.{setting}` key format, a scope chain builder for dynamic tenant hierarchies, a schema registry for aggregating property declarations across modules, and codegen utilities for generating JSON Schema and Zod source from property schemas.

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
deriveNamespace("@weaver-conf/vessel-view-plugin"); // "weaver.vesselView"
```

## API Reference

| Export | Description |
|---|---|
| `deepMerge(base, override)` | Deep merge two config objects |
| `resolveConfiguration(stack)` | Resolve a layer stack into merged entries + provenance |
| `inspectKey(stack, key)` | Inspect a key's value across all layers |
| `createSchemaRegistry()` | Create an incremental schema registry |
| `composeConfigurationSchemas(declarations)` | One-shot schema composition |
| `qualifyKey(namespace, relativeKey)` | Join namespace + key with dot separator |
| `validateKeyFormat(key)` | Validate 3-5 segment camelCase key format |
| `deriveNamespace(pluginId)` | Derive namespace from package/plugin ID |
| `extractNamespace(fqKey)` | Extract first two segments as namespace |
| `generateJsonSchema(schemas)` | Generate a JSON Schema document from property schemas |

## License

MIT
