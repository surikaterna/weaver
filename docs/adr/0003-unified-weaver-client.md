# ADR-0003: Unified WeaverClient

## Status

Accepted

## Context

Browser thick clients need offline-first storage with simple get/set semantics. Backend microservices need schema-aware, layer-targeted access with restart detection. Previously, only a server-side `ConfigurationService` interface existed — never implemented for client consumption. The current `WeaverClient` prototype has basic transport and persistence but lacks type safety, schema validation, layer awareness, and proper namespace support.

We need a single client package that serves both environments with the same core interface, while allowing capabilities to be plugged in based on deployment context.

## Decision

### One client, pluggable capabilities

A single `createWeaverClient()` factory produces a client with opt-in capabilities: transport, persistence, schemas, sync. The same interface works in browser and service contexts. Capabilities degrade gracefully when not configured — a client without persistence simply has no offline cache; a client without schemas skips validation.

### Transport abstraction

Three transport implementations behind one interface:

- **SCOMP over WebSocket** — takes a `peer` object (not raw socket) that handles reconnection and multiplexing
- **HTTP + SSE** — RESTful writes, server-sent event stream for deltas
- **Local** — in-memory, for testing and embedded scenarios

All transports implement the same contract: bootstrap snapshot, push deltas, accept writes.

### Typed namespace accessors (defineNamespace)

`defineNamespace()` accepts a Zod shape matching the canonical nested JSON storage structure. Returns a `NamespaceDefinition` that the client uses to produce a `TypedNamespaceClient<TShape>` with fully inferred types on `get()`, `set()`, and `onChange()`.

### Schema management

Schemas are stored server-side at the `_weaver.schemas` namespace (config about config). Clients subscribe to this namespace when `schemas: true` is set. Validation behavior:

- **Server-schema validation** = soft gate (warn on mismatch, return value)
- **Explicit Zod schema** = hard gate (return `undefined` on parse failure)
- `warnOnMismatch` is configurable per client

### Scope model

- **Tenant** = session/connection boundary. Browser clients bind to one tenant. Microservices use `withScope()` for cross-tenant access.
- **Sub-tenant scopes** (location, department) = lightweight views via `withScope()`. Returns a `ScopedClient` (cheap proxy, same connection).
- Snapshot data includes all scopes the client's auth permits.

### Instance model

Instances represent user-layer personal overrides for identifiable things. Stored at `<basePath>.instances.<instanceId>`, persisted on the user layer by default. `instance()` returns an `InstanceClient` or `TypedInstanceClient`. Available on namespace accessors too.

### Interests (subscription filtering)

Optional `interests[]` limits what snapshot data and deltas the server sends. Default: everything auth allows. Server-side filtering leverages the existing SSE prefix filter. Dynamic interest changes deferred to a future issue.

### Secrets

Transparent to the client. The server resolves `SecretReference` values before sending. Browser clients never see secrets (auth-gated visibility filtering). `inspect()` reveals `secretResolved: true`. `isSensitive(key)` is a convenience derived from schema `x-weaver` metadata.

### Validation behavior matrix

| Server Schema | Zod Shape | Read Behavior | Write Behavior |
|---|---|---|---|
| No | No | Return as-is | Accept, no validation |
| Yes | No | Warn on mismatch, return value | Pre-validate, `WriteResult.success: false` on failure |
| Yes | Yes | Return `undefined` on Zod failure | Pre-validate against both |
| No | Yes | Validate against Zod only | Validate against Zod only |

### Health and modes

- `mode`: `"live"` | `"cached"` | `"degraded"`
- `connected`: boolean
- `revision`: server revision number
- `staleSince`: timestamp when data became stale
- `pendingRestart`: wired to `x-weaver.reloadBehavior` from schema metadata

## Full Interface Specification

```typescript
import type { z } from "zod";
import type {
  ScopeInstance,
  ConfigDelta,
  ConfigSnapshot,
  ConfigurationInspection,
  ConfigurationPropertySchema,
} from "@weaver-conf/config-types";

// --- Factory ---

export function createWeaverClient(options: WeaverClientOptions): WeaverClient;

export function defineNamespace<TShape extends z.ZodRawShape>(
  path: string,
  shape: TShape,
  options?: { description?: string }
): NamespaceDefinition<TShape>;

// --- Options ---

export interface WeaverClientOptions {
  transport: WeaverTransport;
  persistence?: WeaverPersistence;
  schemas?: SchemaOptions | boolean;
  sync?: SyncOptions;
  staleness?: StalenessConfig;
  interests?: string[];
  namespaces?: NamespaceDefinition<z.ZodRawShape>[];
  warnOnMismatch?: boolean;
}

export interface SchemaOptions {
  subscribe?: boolean;
  warnOnMismatch?: boolean;
}

export interface SyncOptions {
  conflictResolution?: "last-write-wins" | "server-wins";
  retryPolicy?: { maxAttempts: number; backoffMs: number };
}

export interface StalenessConfig {
  maxAgeMs: number;
  onStale?: (staleSince: number) => void;
}

// --- Core Client ---

export interface WeaverClient {
  readonly mode: "live" | "cached" | "degraded";
  readonly connected: boolean;
  readonly revision: number | undefined;
  readonly staleSince: number | undefined;
  readonly pendingRestart: boolean;

  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown, options?: WriteOptions): Promise<WriteResult>;
  inspect(key: string): ConfigurationInspection<unknown> | undefined;
  onChange(key: string, handler: (value: unknown) => void): () => void;

  namespace<TShape extends z.ZodRawShape>(
    definition: NamespaceDefinition<TShape>
  ): TypedNamespaceClient<TShape>;
  namespace(path: string): UntypedNamespaceClient;

  withScope(scope: ScopeInstance[]): ScopedClient;
  instance(basePath: string, instanceId: string): InstanceClient;

  registerSchema(request: SchemaRegistrationRequest): Promise<SchemaRegistrationResponse>;
  isSensitive(key: string): boolean;

  onMode(handler: (mode: "live" | "cached" | "degraded") => void): () => void;
  onRestart(handler: () => void): () => void;

  dispose(): Promise<void>;
}

// --- Typed Namespace ---

export interface TypedNamespaceClient<TShape extends z.ZodRawShape> {
  get<K extends keyof TShape & string>(
    key: K
  ): z.infer<z.ZodObject<Pick<TShape, K>>>[K] | undefined;
  set<K extends keyof TShape & string>(
    key: K,
    value: z.infer<z.ZodObject<Pick<TShape, K>>>[K],
    options?: WriteOptions
  ): Promise<WriteResult>;
  onChange<K extends keyof TShape & string>(
    key: K,
    handler: (value: z.infer<z.ZodObject<Pick<TShape, K>>>[K]) => void
  ): () => void;
  inspect<K extends keyof TShape & string>(
    key: K
  ): ConfigurationInspection<z.infer<z.ZodObject<Pick<TShape, K>>>[K]> | undefined;
  instance(instanceId: string): TypedInstanceClient<TShape>;
}

export interface UntypedNamespaceClient {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown, options?: WriteOptions): Promise<WriteResult>;
  onChange(key: string, handler: (value: unknown) => void): () => void;
  inspect(key: string): ConfigurationInspection<unknown> | undefined;
  instance(instanceId: string): InstanceClient;
}

// --- Scoped & Instance ---

export interface ScopedClient {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown, options?: WriteOptions): Promise<WriteResult>;
  onChange(key: string, handler: (value: unknown) => void): () => void;
  namespace<TShape extends z.ZodRawShape>(
    definition: NamespaceDefinition<TShape>
  ): TypedNamespaceClient<TShape>;
  namespace(path: string): UntypedNamespaceClient;
}

export interface InstanceClient {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown, options?: WriteOptions): Promise<WriteResult>;
  onChange(key: string, handler: (value: unknown) => void): () => void;
  inspect(key: string): ConfigurationInspection<unknown> | undefined;
}

export interface TypedInstanceClient<TShape extends z.ZodRawShape> {
  get<K extends keyof TShape & string>(
    key: K
  ): z.infer<z.ZodObject<Pick<TShape, K>>>[K] | undefined;
  set<K extends keyof TShape & string>(
    key: K,
    value: z.infer<z.ZodObject<Pick<TShape, K>>>[K],
    options?: WriteOptions
  ): Promise<WriteResult>;
  onChange<K extends keyof TShape & string>(
    key: K,
    handler: (value: z.infer<z.ZodObject<Pick<TShape, K>>>[K]) => void
  ): () => void;
}

// --- Transport ---

export interface WeaverTransport {
  connect(): Promise<ConfigSnapshot>;
  onDelta(handler: (delta: ConfigDelta) => void): () => void;
  write(key: string, value: unknown, options?: WriteOptions): Promise<WriteResult>;
  onDisconnect(handler: () => void): () => void;
  onReconnect(handler: (snapshot: ConfigSnapshot) => void): () => void;
  dispose(): Promise<void>;
}

export interface WeaverPersistence {
  load(): Promise<ConfigSnapshot | undefined>;
  save(snapshot: ConfigSnapshot): Promise<void>;
  clear(): Promise<void>;
}

// --- Write ---

export interface WriteOptions {
  layer?: string;
  scope?: ScopeInstance[];
}

export interface WriteResult {
  success: boolean;
  revision?: number;
  validation?: ValidationResult;
}

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
}

// --- Namespace Definition ---

export interface NamespaceDefinition<TShape extends z.ZodRawShape> {
  readonly path: string;
  readonly shape: TShape;
  readonly description?: string;
}
```

## Usage Examples

### 1. Browser thick client with offline + typed namespaces

```typescript
import { createWeaverClient, defineNamespace, createHttpTransport, createIndexedDbPersistence } from "@weaver-conf/weaver-client";
import { z } from "zod";

const uiPrefs = defineNamespace("app.ui", {
  theme: z.enum(["light", "dark", "system"]),
  fontSize: z.number().min(10).max(24),
  sidebar: z.object({ collapsed: z.boolean(), width: z.number() }),
});

const client = createWeaverClient({
  transport: createHttpTransport({ url: "/api/config" }),
  persistence: createIndexedDbPersistence({ dbName: "my-app" }),
  namespaces: [uiPrefs],
});

const ui = client.namespace(uiPrefs);
const theme = ui.get("theme"); // type: "light" | "dark" | "system" | undefined
ui.onChange("fontSize", (size) => {
  // size: number
  document.documentElement.style.fontSize = `${size}px`;
});
```

### 2. Backend microservice with schema + restart detection

```typescript
import { createWeaverClient } from "@weaver-conf/weaver-client";
// import { createScompTransport } from "@weaver-conf/weaver-client"; // SCOMP client transport not yet implemented
import { peer } from "./scomp-peer.js";

const client = createWeaverClient({
  // transport: createScompTransport({ peer }), // SCOMP client transport not yet implemented
  transport: createHttpTransport({ baseUrl: "http://weaver-server:3399" }),
  schemas: true,
  staleness: { maxAgeMs: 30_000 },
});

client.onRestart(() => {
  log.info("Config change requires restart, draining...");
  server.drain().then(() => process.exit(0));
});

const dbHost = client.get<string>("database.host");
```

### 3. Multi-tenant microservice with cross-tenant scope

```typescript
const client = createWeaverClient({
  // transport: createScompTransport({ peer }), // SCOMP client transport not yet implemented
  transport: createHttpTransport({ baseUrl: "http://weaver-server:3399" }),
  schemas: true,
});

async function handleRequest(tenantId: string, locationId: string) {
  const scoped = client.withScope([
    { scope: "tenant", value: tenantId },
    { scope: "location", value: locationId },
  ]);
  const maxRetries = scoped.get<number>("api.maxRetries");
  return maxRetries;
}
```

### 4. Testing with local transport

```typescript
import { createWeaverClient, createLocalTransport } from "@weaver-conf/weaver-client";

const client = createWeaverClient({
  transport: createLocalTransport({
    initial: { "app.ui.theme": "dark", "app.ui.fontSize": 14 },
  }),
});

const theme = client.get("app.ui.theme"); // "dark"
await client.set("app.ui.theme", "light");
```

## Consequences

### Positive

- One package to learn, same patterns in browser and service
- Type safety via `defineNamespace` without codegen
- Graceful degradation — schemas, persistence, and sync are all optional
- Namespace declarations are the single source of truth (compile-time types + server registration)

### Negative

- `TypedNamespaceClient` type inference requires Zod as a type-level dependency
- Server needs schema persistence (#58) for the full validation story
- Dynamic interests deferred to future work

### Risks

- Zod version coupling between client and server packages
- Schema drift between local `defineNamespace` validation and server-persisted schemas (mitigated by explicit path-first service/fragment registration and server-side validation)

## Related

- ADR-0002: weaver-server (§7 Schema Registration)
- GitHub #57: Unified WeaverClient implementation
- GitHub #58: Schema persistence gap
- GitHub #59: ADR audit
