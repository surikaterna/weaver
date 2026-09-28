# ADR-0003: Unified WeaverClient

## Status

Accepted (amended by the JSON-Schema-first client design)

## Context

Browser clients need synchronous local reads and optional offline persistence. Backend
services need layer-targeted writes, schema metadata, and restart detection. Both use
the same transport-backed client, but a prior design also made local Zod declarations
authoritative for namespace types and runtime validation. That created a second schema
model beside the canonical JSON Schema registered with Weaver.

## Decision

### One client with pluggable capabilities

`createWeaverClient()` creates the same client in browser and service contexts.
Transport is required; persistence, schema fetching, and staleness monitoring remain
optional. Reads come from local state and writes go through the configured transport.

### JSON Schema is the sole runtime schema model

`ConfigurationPropertySchema` is the only schema model. A service or fragment provider
passes a canonical `SchemaRegistrationRequest` directly to `client.registerSchema()`.
The request is validated by the shared config-types contract before an HTTP effect and
is then forwarded without conversion or field reconstruction.

The server is authoritative for write and effective-configuration validation. When
`schemas: true` is enabled, the client can fetch schemas for soft read warnings,
preflight writes, sensitivity metadata, and restart metadata. Those checks delegate to
config-engine's `validateEffectiveConfiguration()` and return its
`SchemaValidationResult`; the client does not maintain a second validator.

### Generic namespace and instance views

Consumers provide a generated or handwritten TypeScript interface when selecting a
path:

```typescript
interface UiConfig {
  theme: "light" | "dark" | "system";
  fontSize: number;
}

const ui = client.namespace<UiConfig>("app.ui");
const theme = ui.get("theme"); // UiConfig["theme"] | undefined
await ui.set("fontSize", 16);
```

The generic constrains keys and values at compile time only. It is erased at runtime,
does not parse values, and is not proof that local state matches the interface. Runtime
truth comes from the registered JSON Schema and server enforcement. Calling
`namespace("dynamic")` defaults to `Record<string, unknown>`.

There is no `defineNamespace`, `NamespaceDefinition`, Zod-backed namespace client,
schema argument on `get`, automatic conversion, or compatibility overload. Code
generation from JSON Schema may be supplied by consumers, but is not part of the
client.

### Transport abstraction

HTTP/SSE, SCOMP, and local transports share the client transport contract. Schema
registration is an optional transport capability but a required `WeaverClient` method;
unsupported transports return the existing typed unsupported result. Registered HTTP
operations validate request and response contracts, preserve cancellation, retry only
safe reads, and never replay mutations.

### Scope and instance model

`withScope()` creates a namespace view over a scope path while preserving its generic.
`instance()` stores overrides at `<basePath>.instances.<instanceId>`, reads the instance
first, and falls back to the base path. Instance writes and resets accept normal write
options.

### Health, metadata, and lifecycle

- `mode`: `"live" | "cached" | "degraded"`
- `connected`, `revision`, `lastSyncedAt`, and `staleSince` expose client state.
- `pendingRestart` and `isSensitive()` use fetched `x-weaver` metadata.
- `close()` releases subscriptions, monitors, and transport resources.

## Canonical API

```typescript
interface WeaverClient {
  namespace<TConfig extends object = Record<string, unknown>>(
    path: string,
  ): NamespaceClient<TConfig>;

  instance<TConfig extends object = Record<string, unknown>>(
    basePath: string,
    instanceId: string,
  ): InstanceClient<TConfig>;

  registerSchema(
    request: SchemaRegistrationRequest,
  ): Promise<SchemaRegistrationResponse>;
}

interface NamespaceClient<TConfig extends object> {
  get<K extends Extract<keyof TConfig, string>>(
    key: K,
  ): TConfig[K] | undefined;
  getOrDefault<K extends Extract<keyof TConfig, string>>(
    key: K,
    defaultValue: TConfig[K],
  ): TConfig[K];
  getAll(): Partial<TConfig>;
  set<K extends Extract<keyof TConfig, string>>(
    key: K,
    value: TConfig[K],
    options?: WriteOptions,
  ): Promise<WriteResult>;
  setMany(values: Partial<TConfig>, options?: WriteOptions): Promise<WriteResult>;
  remove<K extends Extract<keyof TConfig, string>>(
    key: K,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  onChange<K extends Extract<keyof TConfig, string>>(
    key: K,
    handler: (value: TConfig[K] | undefined) => void,
  ): Unsubscribe;
  onChange(handler: (deltas: ConfigDelta[]) => void): Unsubscribe;
  withScope(scopePath: ScopeInstance[]): NamespaceClient<TConfig>;
  instance(instanceId: string): InstanceClient<TConfig>;
}

interface InstanceClient<TConfig extends object> {
  get<K extends Extract<keyof TConfig, string>>(
    key: K,
  ): TConfig[K] | undefined;
  getOrDefault<K extends Extract<keyof TConfig, string>>(
    key: K,
    defaultValue: TConfig[K],
  ): TConfig[K];
  set<K extends Extract<keyof TConfig, string>>(
    key: K,
    value: TConfig[K],
    options?: WriteOptions,
  ): Promise<WriteResult>;
  reset(options?: WriteOptions): Promise<WriteResult>;
  onChange<K extends Extract<keyof TConfig, string>>(
    key: K,
    handler: (value: TConfig[K] | undefined) => void,
  ): Unsubscribe;
}
```

## Consequences

### Positive

- Registration, server enforcement, and optional client validation use one canonical
  JSON Schema model.
- Consumers can use generated interfaces without coupling the public client API to a
  schema library.
- Public types no longer require a Zod peer dependency.
- Registered HTTP behavior remains strict and retry-safe.

### Negative

- Generic interfaces can drift from runtime values because they are compile-time-only.
- Consumers that want generated types need an external JSON-Schema-to-TypeScript
  workflow.
- Removing the prior Zod namespace surface is a breaking API change.

## Related

- ADR-0002: weaver-server schema registration
- Schema Registration Gap Analysis
- weaver-x4yp.6 / PR #159
