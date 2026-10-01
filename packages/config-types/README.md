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
## Domain schema adapters (pre-1 migration)

The path/environment/identifier, configuration-service DTO/capability, and coupled
snapshot/read schemas use descriptor-first domain captures rather than concrete
Zod object, tuple, or preprocess containers. This is a minor breaking concrete
schema API change during pre-1 development, not a domain or wire redesign.
`z.input`, `z.output`, brands, nonempty readonly relative tuples, ordered identity
scopes, and callable signatures are retained. Normal `parse`/`safeParse` usage is
unchanged; failed domain checks return payload-safe Zod errors. Engine snapshot
hazards retain their typed Weaver-error rejection before reads.

Do not traverse `.in`/`.out`/`.shape` or use `unwrap`/`extend`/`pick` on the migrated
schemas. Use domain helpers or declare an application-specific Zod schema instead:

```ts
import { captureConfigurationServiceIdentity } from "@weaver-conf/config-types";
const result = captureConfigurationServiceIdentity(input);
if (result.success) {
  // Detached, frozen identity with its original ordered scope tuple.
  consumeIdentity(result.value);
}
```

`isRegistrationEnvironment`, `isPublicSlashPath`,
`isLiteralConfigurationSegment`, and `isCanonicalConfigurationPath` are the same
predicates used by public schemas. They do not normalize Unicode, decode paths,
infer principals, or authenticate an inspection handle. Callable schema checks
never invoke capabilities or prove their behavior. Unrelated concrete schemas,
including `scopeInstanceSchema`, retain their object APIs.

Captures inspect all own descriptors before domain fields, reject boundary-specific
cycles/exotic containers/symbols, preserve acyclic sharing, and never freeze a
borrowed input. Ordinary data arrays may retain holes; structural identity and
contribution arrays must be dense. Snapshot data and service data retain their
distinct reserved-key and executable-data rules. The storage codec remains the
engine's existing `parsePath`/`buildPath` authority.
