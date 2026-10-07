# ADR-0003: Unified WeaverClient

## Status

Accepted (amended by the JSON-Schema-first client design)

## Hosting clarification — 2026-10-02

The unified transport-backed client remains the consumer SDK for browser and backend
applications. It is not mandatory infrastructure inside a configuration authority:
`config-service` directly owns registered projections, identity revisions and provider
lifecycle, without an internal SDK cache or snapshot transport. An optional local
consumer adapter may sit outside that authority; it is not implemented by this decision.

The approved target shares this application authority between embedded and central
hosting; the existing server has **not yet been migrated**. Server adapters retain
authentication, transports and durable bootstrap. One authoritative API writer per
backing domain is a deployment responsibility, not a distributed mutex or transaction.
Configured external inputs may refresh through the authority publication path without
implying concurrent-writer coordination. No automatic hybrid mutation replay is promised:
pending is not committed, required flush is not universal durability, and a timeout
after dispatch does not establish rollback. The historical consumer decisions below
remain applicable except where this hosting clarification explicitly narrows them.

## Context

### Hosting progress — 2026-10-03

`weaver-0b81.5.3` introduces an opt-in programmatic central host for the shared
authority's registered public primitive/null leaf operations. The default
one-argument service root remains read-only; explicit host options enable
governed writes. The legacy server remains the default. This new raw HTTP subset
uses canonical hydrated inspection and intentionally omits list/SSE startup,
live schema administration, sessions and aggregate handles. It therefore does
**not** certify current SDK compatibility or imply a new internal SDK dependency.
The full SDK matrix remains `weaver-0b81.9`; independent integrated audit and
packed consumer gates remain required. Historical architecture below is retained
without expanding replay, distributed-writer or durability guarantees.

`weaver-sbmu` replaces native root/query writers with one host-capability mutation
port, `forMutations(token).apply(commands)`. Ordered JSON set/remove/value-patch
commands share the existing FIFO and stage every prefix before effects. Grouped
flush and per-command receipts distinguish rejected, known partial and unknown
outcomes without transaction or rollback fiction. The existing authority HTTP writes
submit one-command lists and return this result directly; public aggregate queries
remain projected. This does not add network batch/patch/validation routes or certify
the legacy transport SDK against the native command API.

`weaver-xezt` gives the shared configuration root one owned live registry and an
explicit host-only schema capability port. Registration shares the data FIFO and
stages metadata, encoded persistence and all ready projections before provider
effects; required flush precedes publication. The central host supplies detached
bootstrap data and the selected storage binding, not a separately owned reader.
Uncertain schema persistence fences all payload access until root recreation,
because disclosure policy itself may have changed. The shared-authority HTTP/SCOMP
schema surface and default-server cutover remain separate work; this is not SDK
parity, multi-writer coordination or automatic recovery.

`weaver-0b81.7` connects native reader notifications to that same publication seam.
Committed batches/prefixes, schema invalidations and validated reload/readback
observations share one `ConfigurationReaderChange` union. Delivery reauthorizes the
captured selection; obsolete policy evidence yields value-free invalidation, not old
values under new policy. Root reload, declared-writer flush, explicit provider watch
ownership and revision-bounded restart acknowledgement use the same FIFO. Neither
reload nor acknowledgement clears uncertainty. These are core capabilities, not an
HTTP/SSE/SCOMP feed or a migrated SDK cache; those integrations remain separate work.

`weaver-0b81.8` integrates shared ephemeral contributions at an explicit configured
session slot. The existing `config-sessions` domain remains the sole entry/metadata/
lease/timer owner; root-local references and issued capabilities provide confinement.
The only lifecycle port is `forSessions(capability)`; data still uses `apply` with
a checked selector. Deadline/revocation cuts off new dispatch immediately while
effective fallback waits on the same serialized publication queue. It is not a
rollback of already accepted effects. Emergency membership never relaxes ordinary
grants, visibility or schema admission, and ceilings remain separate work. Native
feature tests replace the unwired server session map/sweeper before its removal;
no compatibility facade or network endpoint is introduced.

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
