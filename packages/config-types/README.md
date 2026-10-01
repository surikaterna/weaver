# @weaver-conf/config-types

> Core type definitions, Zod schemas, and the `defineWeaver()` builder for declaring layered configuration stacks.

## Installation

```bash
pnpm add @weaver-conf/config-types
```

## Overview

`@weaver-conf/config-types` is the foundational package in the Weaver configuration system. It defines the type-level contracts that all other `@weaver-conf/config-*` packages depend on: layer definitions, storage provider interfaces, property schemas, session types, sync types, and access control types.

The centerpiece is `defineWeaver()` — a builder that takes an `as const` tuple of layer definitions and returns a fully-typed `WeaverConfig`. Layer names, order (rank), and types are all consumer-declared. There are no hardcoded layer names or roles.

The package also exports `Layers.*` factories for the four built-in layer types (Static, Dynamic, Personal, Ephemeral) and `replaceOnly` as an alternative merge strategy. Consumers can implement the `LayerType` interface to create custom layer types.

## Usage

### Declaring a layer stack with `defineWeaver`

```typescript
import { defineWeaver, Layers, replaceOnly } from "@weaver-conf/config-types";

const weaver = defineWeaver([
  Layers.Static("core"),
  Layers.Static("app"),
  Layers.Dynamic("features"),
  Layers.Static("module"),
  Layers.Static("integrator"),
  Layers.Static("tenant"),
  Layers.Dynamic("organizational"),
  Layers.Personal("user"),
  Layers.Personal("device"),
  Layers.Ephemeral("session", { merge: replaceOnly }),
] as const);

// Type-safe layer access
weaver.getRank("tenant"); // => 5
weaver.getLayer("user");  // => LayerDefinition<"user">
weaver.getLayersByType("dynamic"); // => [features, organizational]
weaver.layerNames; // => readonly ["core", "app", ..., "session"]
```

### Implementing a custom LayerType

```typescript
import type { LayerType } from "@weaver-conf/config-types";

const cacheBustedType: LayerType = {
  id: "cache-busted",
  persistent: false,
  defaultMerge: (base, override) => override ?? base,
  createResolver(provider, config) {
    return { resolve: (ctx) => [] };
  },
};
```

### Using Zod schemas for runtime validation

```typescript
import {
  configurationLayerSchema,
  configurationPropertySchemaSchema,
} from "@weaver-conf/config-types";

const parsed = configurationPropertySchemaSchema.parse(untrustedInput);
```

## API Reference

### Builder & Layers

| Export | Description |
|---|---|
| `defineWeaver(layers)` | Create a typed `WeaverConfig` from an as-const layer array |
| `Layers.Static(name, config?)` | Factory for persistent, non-scoped layers |
| `Layers.Dynamic(name, config?)` | Factory for persistent, scope-aware layers |
| `Layers.Personal(name, config?)` | Factory for persistent, user-bound layers |
| `Layers.Ephemeral(name, config?)` | Factory for non-persistent session layers |
| `replaceOnly` | Merge function that replaces entirely (no deep merge) |

### Key Types

| Type | Description |
|---|---|
| `WeaverConfig<T>` | Typed config object with `getRank()`, `getLayer()`, `getLayersByType()` |
| `LayerDefinition<N>` | A bound layer: name + type + config |
| `LayerType` | Interface for implementing custom layer types |
| `MergeFunction` | `(base, override) => merged` — layer merge strategy |
| `ConfigurationStorageProvider` | Read/write interface for layer storage backends |
| `ConfigurationService` | High-level service interface (get, set, inspect, onChange) |
| `ConfigurationPropertySchema` | Schema for a single config key (type, visibility, changePolicy, etc.) |
| `ConfigurationLayerStack` | Ordered array of layer entries for resolution |
| `OverrideSession` | Session state with expiration and override tracking |
| `ConfigurationAccessContext` | Caller identity (roles, sessionMode) for auth checks |

### Zod Schemas

All core types have corresponding Zod schemas exported from `schemas-core` and `schemas-providers` (e.g., `configurationLayerSchema`, `writeResultSchema`, `promotionRequestSchema`).

## License

MIT
## Native contracts and caller-data admission

Paths and identifiers use native Zod string schemas. Service DTOs and capabilities
use native object, union and readonly tuple schemas behind descriptor-first
admission. Zod owns the domain rules; no parallel domain-validator framework is
required. `parse`/`safeParse`, schema input/output types, brands, ordered scopes,
nonempty relative tuples and callable signatures retain their original meaning.
For guarded schemas, the native contract is available through `.out`; unwrap a
readonly schema before using `.shape`, `.extend`, `.pick` or `.omit`. Refinements
still apply; use Zod's `safeExtend` when extending an object with cross-field rules.

Admission rejects own accessors without invoking them, rejects boundary-specific
cycles/exotic containers/symbols, preserves acyclic sharing, and never freezes a
borrowed input. Ordinary data arrays may retain holes; structural metadata arrays
must be dense. Snapshot data and service data retain their distinct reserved-key
and executable-data rules. Callable checks do not execute or authenticate a
capability. The engine's `parsePath`/`buildPath` remains the storage codec.

These are caller-data contracts under standard JavaScript prototypes, not a
sandbox for executable modification of ambient Object/Array prototypes or Proxy
reflection. Native Zod compilation, issue arrays and output construction are
ordinary trusted implementation machinery.
