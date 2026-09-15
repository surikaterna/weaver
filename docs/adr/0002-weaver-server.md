# ADR-0002: weaver-server — Central Configuration Server

> **Historical design record:** repository bootstrap/server.json, hardcoded ranks, environment bootstrap options and aggregate registry examples below are retired, not current supported interfaces. Preserve the architectural rationale; use the [current seed/bootstrap contract](../guides/bootstrap-config-repo.md) and [removal inventory](../bootstrap-removal-inventory.md) for executable behavior.

> **Status**: Accepted. Note: packages `config-providers` and `config-server` referenced in this ADR were consolidated into `weaver-server` in Phase 1 (May 2026).

- **Status**: Proposed
- **Date**: 2026-05-02
- **Depends on**: ADR-0001 (Marker Architecture, Secret Management)
- **Issue**: weaver-hw7

## Context

ADR-0001 established the marker architecture, secret management model, service declarations, access policies, environment overlays, and mount resolution for Weaver. It designated a central configuration server (weaver-server) as the primary enforcement point for most of these features but deferred its design.

This ADR defines the architecture of weaver-server: the central service that stores configuration, enforces access policies, resolves secrets, manages schema registration, handles environment promotion, and serves resolved config to backend services and browser clients.

### What ADR-0001 Decided (Inherited Constraints)

These decisions are locked and inherited by this ADR:

- Fully central deployment: one server resolves all secrets, serves resolved config
- `ServiceAccessPolicy` ∩ `ServiceConfigurationDeclaration` = effective access
- `_weaver.*` reserved namespace for schemas, policies, server config
- Environment pre-merge overlays (base + env overlay merged before state container)
- Secret resolution server-side only (services receive resolved plaintext)
- `changePolicy` enforcement at write time against promotion pipeline
- `_weaver` marker system (`SecretReference`, `ConfigMount`) with shadow map resolution
- Bracket notation for compound key identifiers (FQDN plugin IDs)

### What This ADR Decides

- Runtime, process model, and framework choices
- Storage architecture: Git + MongoDB with per-layer configurable providers
- Config repository structure and Git interaction model
- Bootstrap sequence (self-hosting from own config)
- Transport layer: scomp (primary), REST, SSE
- WeaverClient architecture: transport interface, tenant modes, offline persistence
- Authentication and authorization model
- Environment promotion and rollback
- Schema registration lifecycle
- Change detection and delta streaming
- Audit system with pluggable sinks
- Tenant provisioning and isolation model
- Override sessions
- Health, observability, and logging

## Decision

### 1. Runtime and Process Model

**Bun** is the runtime, consistent with the rest of the weaver monorepo. The server runs as a **single Bun process** serving all transports (scomp WebSocket, REST, SSE) on a single port with path-based routing:

| Path | Transport | Purpose |
|---|---|---|
| `/scomp` | WebSocket (scomp protocol) | Primary M2M config serving, admin operations |
| `/api/*` | REST (HTTP) | Ad-hoc support, CLI tools, curl |
| `/events` | SSE | Change streaming fallback for clients not using scomp |
| `/healthz` | HTTP GET | Kubernetes liveness probe |
| `/readyz` | HTTP GET | Kubernetes readiness probe (false during bootstrap) |

All transports share the same core service logic. The transport layer is a thin adapter.

### 2. Storage Architecture

Storage is **per-layer configurable**. Each layer declares its storage provider, and providers are pluggable. Two providers are built for v1:

#### GitStorageProvider

Primary storage for reviewed, version-controlled config:

- **Reads**: Direct filesystem reads from a local Git clone (`fs.readFile` on JSON files)
- **Writes**: `simple-git` library for add/commit/push operations
- **PR creation**: `gh` CLI for pull request operations (when `changePolicy` requires review)
- **Authentication**: GitHub token via `WEAVER_GIT_TOKEN` environment variable

Git interaction stack:
- `simple-git` — programmatic API for git pull/add/commit/push (avoids manual shell escaping)
- `gh` CLI — PR creation, merge, status checks (already in the team's workflow)
- `fs` — direct file reads for config loading (fast, no git overhead for reads)

#### MongoDBStorageProvider

Storage for high-frequency, per-user/device data:

- **Driver**: Native `mongodb` driver (not Mongoose — config data is schemaless JSON)
- **Collection**: Single collection with discriminator field for layer type
- **Document shape**: `{ layer, environment, tenantId?, userId?, deviceId?, key, value, updatedAt }`

#### Layer-to-Provider Mapping

| Layer | Provider | Reason |
|---|---|---|
| `_weaver` (schemas, policies, server config) | Git (v1), pluggable | Version-controlled metadata, environment overlays for schemas |
| Platform / static | Git | Stable, reviewed, version-controlled |
| Tenant layers | Git | Reviewed changes, GitOps workflow |
| User layers | MongoDB | Frequent per-user writes |
| Device layers | MongoDB | Frequent per-device writes |
| Ephemeral / session | In-memory | Not persisted by definition |

Provider assignment is configured in bootstrap (see section 4). The mapping is changeable without code changes — a tenant layer could be moved to MongoDB in the future if write patterns demand it.

### 3. Config Repository Structure

A **single Git repository** holds all Git-backed config, including the `_weaver` layer, platform layers, and tenant layers:

```
weaver-config/
  bootstrap/
    server.json                         ← bootstrap config (layers, providers)
  layers/
    _weaver/
      base/
        schemas/
          lynx.json                     ← ServiceConfigurationDeclaration
          vessel-tracking.json
        policies/
          lynx.json                     ← ServiceAccessPolicy
          vessel-tracking.json
        server.json                     ← _weaver.server.* config
      env.staging/
        schemas/
          lynx.json                     ← staging-specific schema (newer version)
      env.production/
        schemas/
          lynx.json                     ← production schema (current version)
    platform/
      base/
        db.json                         ← { "host": "localhost", "port": 5432 }
        sentinel.json
      env.staging/
        db.json                         ← { "host": "staging-db.internal" }
      env.production/
        db.json                         ← { "host": "prod-db.internal" }
    tenant:acme/
      base/
        lynx.json                       ← { "maxUsers": 1000 }
      env.production/
        lynx.json                       ← { "maxUsers": 5000 }
    tenant:globex/
      base/
        lynx.json
```

**Why single repo:**
- Cross-cutting changes are atomic (platform config + affected tenant overrides in one PR)
- Promotion is a file copy within the same repo
- `CODEOWNERS` scopes review per directory
- Simpler bootstrap (one repo URL)
- Full visibility across all layers and environments

**When to split** (future): If tenants need hard access isolation (tenant A's team must never see tenant B's config), split to repo-per-tenant. This is a deployment-time decision, not an architecture change — the GitStorageProvider takes a repo URL per layer.

### 4. Bootstrap Sequence

weaver-server uses Weaver to manage its own config (`_weaver.*` namespace). This creates a bootstrap problem: the server needs config to start, but config comes from the server.

**Resolution: Git-backed bootstrap with environment variable assistance.**

The bootstrap sequence has two phases:

**Phase 1 — Minimal bootstrap (env vars + Git):**

```
1. Read environment variables:
   WEAVER_CONFIG_REPO      — Git repo URL
   WEAVER_CONFIG_BRANCH    — branch (default: "main")
   WEAVER_GIT_TOKEN        — GitHub authentication token
   WEAVER_ENVIRONMENT      — environment this instance serves (e.g., "production")

2. Clone or pull the config repo to local disk

3. Read bootstrap/server.json from the cloned repo:
   {
     "layers": [
       { "id": "_weaver",       "provider": "git", "path": "layers/_weaver" },
       { "id": "platform",      "provider": "git", "path": "layers/platform" },
       { "id": "tenant:*",      "provider": "git", "path": "layers/tenant:*" },
       { "id": "user",          "provider": "mongodb", "collection": "config_layers" },
       { "id": "device",        "provider": "mongodb", "collection": "config_layers" },
       { "id": "ephemeral",     "provider": "memory" }
     ],
     "mongodb": {
       "uri": "${WEAVER_MONGO_URI}"
     }
   }

4. Resolve ${ENV_VAR} placeholders in bootstrap values

5. Load all Git-backed layers (with environment pre-merge for WEAVER_ENVIRONMENT)
```

**Phase 2 — Full startup (self-hosting):**

```
6. Build state container from loaded layers
   - _weaver layer provides: schemas, policies, server config
   - Platform + tenant layers provide: application config

7. Read _weaver.server.* from resolved config:
   - _weaver.server.transport.scomp.port (default: 3399)
   - _weaver.server.transport.rest.port (or same port, path-routed)
   - _weaver.server.vault.endpoint
   - _weaver.server.adminRoles
   - _weaver.server.promotionPipeline

8. Connect to vault (if _weaver.server.vault.endpoint is set)
   - Resolve all SecretReference markers via SecretResolutionService
   - Build secret shadow map

9. Connect to MongoDB (if any layers use mongodb provider)
   - Load user/device layer data into state container

10. Resolve mounts (build mount map from ConfigMount markers)

11. Start transports (scomp WebSocket + REST + SSE on configured port)

12. Set /readyz to true — server is ready to serve
```

**No vault at bootstrap**: The vault endpoint is a non-secret config value stored in Git (`_weaver.server.vault.endpoint`). Vault connection happens at step 8, after Git config is loaded. The only secrets in environment variables are the Git token and optionally the MongoDB URI.

**Degraded mode**: If the Git repo is unavailable at startup:
- If a local clone exists from a previous run, start with cached (stale) state
- Reject write operations
- Set `/readyz` to false (Rancher/K8s won't route traffic)
- Continue retrying Git pull in the background
- Log warnings via SLF

### 5. Layer Configuration and `_weaver` Layer

The `_weaver` layer is a **dedicated layer** in the stack, separate from platform config. It holds metadata about config (schemas, policies, server config), not config itself.

| `_weaver.*` data | Environment-scoped? | Reason |
|---|---|---|
| `_weaver.schemas.*` | **Yes** | Different service versions may run in different environments |
| `_weaver.policies.*` | **No** | Access rules are consistent across environments |
| `_weaver.server.*` | **No** | Server config is instance-level, not environment-specific |

The `_weaver` layer is Git-backed in v1 but its provider is configurable — it could be moved to MongoDB or another backend without architectural changes.

The `_weaver` layer does not participate in the normal merge stack for application config. It is loaded and queried separately by the server. Services never read from `_weaver.*` directly — the server uses it internally for enforcement.

### 6. Environment Model and Promotion

#### Environment Overlay Model (from ADR-0001)

Each layer has a `base/` directory plus optional `env.<name>/` overlay directories. Overlays are deep-merged onto base before entering the state container. The environment is specified at server startup via `WEAVER_ENVIRONMENT`.

#### Promotion

Promotion moves a config value from one environment to another **within the same layer**. Cross-layer promotion is not supported (that would be a different operation: standardizing an override into a default).

The promotion pipeline is defined in `_weaver.server.promotionPipeline`:
```json
["dev", "staging", "canary", "production"]
```

The `changePolicy` extension (from ADR-0001) determines the promotion path:

| `changePolicy` | Promotion path | Mechanism |
|---|---|---|
| `full-pipeline` | dev → staging → canary → production | PR per stage (via `gh pr create`) |
| `staging-gate` | staging → production | PR or direct commit |
| `direct-allowed` | Direct write to any environment | Direct Git commit |
| `emergency-override` | Direct write during active override session | Direct Git commit + audit |

**Promotion API:**

```
POST /admin/promote
{
  key: "lynx.maxUsers",
  layer: "tenant:acme",
  fromEnvironment: "staging",
  toEnvironment: "production"
}
```

Server behavior:
1. Read current value from source environment
2. Check `changePolicy` for the key (from schema's `x-weaver` extensions)
3. If PR required: create branch, copy file content, `gh pr create`
4. If direct allowed: copy value, `git commit`, `git push`
5. Create audit entry
6. If direct: reload affected layer, push delta to connected clients

**Automated CI promotion:**

The promotion API supports automated callers. CI/CD pipelines can call the promote endpoint after successful deployment validation:

```
1. CI deploys service to staging
2. CI runs integration tests
3. Tests pass → CI calls POST /admin/promote { from: "staging", to: "canary" }
4. Canary soak period
5. CI calls POST /admin/promote { from: "canary", to: "production" }
```

The `changePolicy` determines whether CI can promote directly or whether a PR gate is inserted. For `full-pipeline`, CI creates the promotion request and a human approves the PR.

**Promotion scope:** Platform and tenant layers only. User and device layers (MongoDB-backed) are not subject to promotion — they represent per-user/device preferences that don't vary by environment.

### 7. Schema Registration and Lifecycle

Services register their `ServiceConfigurationDeclaration` at runtime via the scomp transport. The server persists schemas in Git, committing only when the schema actually changes.

**Registration flow:**

```
1. Service starts, connects to weaver-server via scomp
2. Service sends registerSchema({ declaration, environment })
3. Server loads existing schema from _weaver.schemas.{serviceId} for that environment
4. If schema unchanged (same schemaVersion, deep equal): acknowledge, done
5. If schema changed:
   a. Validate new schema (structural checks, Zod parse)
   b. Diff against previous: detect breaking changes (removed properties, type changes)
   c. If breaking change detected: warn (log), optionally reject based on server policy
   d. Commit updated schema to env.{environment}/_weaver.schemas.{serviceId}.json
   e. Push to remote
   f. Acknowledge to service
6. If first registration (no existing schema): commit to base/ and acknowledge
```

**Environment-scoped schemas:**

Different environments may run different versions of a service. Staging might have Lynx v2.3 with a new `analytics.samplingRate` property, while production runs Lynx v2.2 without it.

Schemas are stored with environment overlays in the `_weaver` layer:
- `base/schemas/lynx.json` — common base schema
- `env.staging/schemas/lynx.json` — staging-specific schema (if different)
- `env.production/schemas/lynx.json` — production-specific schema

When a service is promoted to a new environment and registers its schema there, the environment-specific schema file is updated.

**Server restart resilience:**

On startup, the server loads all schemas from the `_weaver` layer in Git. If a service is down when the server starts, its last-known schema is still available from Git. When the service reconnects, it re-registers (which is a no-op if unchanged).

### 8. Transport Layer

weaver-server exposes the same core service logic through three transports. All share a single HTTP port with path-based routing.

#### 8.1 scomp (Primary)

scomp is a transport-agnostic RPC toolkit (from the `@scomp/*` packages) with `request`, `signal`, and `feed` semantics. It serves as the **primary interface** for both M2M config serving and admin operations.

The scomp transport uses a `ContractToken` to define the typed API surface. The server implements the contract; clients consume it.

**Config serving operations:**

| Operation | Type | Purpose |
|---|---|---|
| `resolveAll` | request | Full config snapshot for a service (startup path) |
| `get` | request | Single key lookup |
| `getNamespace` | request | All keys under a prefix |
| `inspect` | request | Full provenance for a key |
| `configChanges` | feed | Live delta stream for a service's config |
| `registerSchema` | request | Register/update ServiceConfigurationDeclaration |

**Admin operations:**

| Operation | Type | Purpose |
|---|---|---|
| `promote` | request | Promote a value between environments |
| `rollback` | request | Revert a commit |
| `setPolicy` | request | Create/update ServiceAccessPolicy |
| `getPolicy` | request | Read a ServiceAccessPolicy |
| `provisionTenant` | request | Create tenant layer structure |
| `getAuditLog` | request | Query audit entries (future) |

**Feed semantics:**

The `configChanges` feed pushes **deltas** (changed key + new value + provenance). If a client needs a fresh snapshot, it calls `resolveAll` (a regular request, not a feed operation).

Delta payload:
```typescript
interface ConfigDelta {
  key: string;
  value: unknown;
  layer: string;
  environment: string;
  timestamp: string;
}
```

Provenance is included in deltas — it's inexpensive and valuable for debugging. Most clients will ignore it, but admin UIs and troubleshooting tools benefit from it.

**Reconnection model:**

If a client disconnects and reconnects, it subscribes to the `configChanges` feed again and requests a full snapshot via `resolveAll`. There is no revision-based catch-up or delta buffer. The server does not track client state. This keeps the server stateless with respect to client connections.

#### 8.2 REST

REST endpoints mirror the scomp contract for ad-hoc access:

```
GET  /api/config/:serviceId                    → resolveAll
GET  /api/config/:serviceId/:key               → get
GET  /api/config/:serviceId/namespace/:prefix   → getNamespace
GET  /api/config/:serviceId/inspect/:key        → inspect
POST /api/admin/promote                         → promote
POST /api/admin/rollback                        → rollback
POST /api/admin/policies                        → setPolicy
GET  /api/admin/policies/:serviceId             → getPolicy
POST /api/admin/tenants                         → provisionTenant
POST /api/schemas/register                      → registerSchema
```

REST is for support tooling, curl, and clients that cannot use scomp. It is not the primary serving path.

#### 8.3 SSE

SSE provides change streaming for clients that want live updates without scomp:

```
GET /events/:serviceId?keys=db.*,lynx.*
```

Returns a Server-Sent Events stream of config deltas in the same format as the scomp `configChanges` feed. This serves as a fallback for backend services that prefer HTTP-based streaming and for browser clients.

### 9. WeaverClient Architecture

WeaverClient is the **developer-facing client library** that wraps the transport layer and provides a high-level API for config access.

#### 9.1 Transport Interface

WeaverClient uses a defined transport interface with two implementations:

```typescript
interface WeaverTransport {
  resolveAll(serviceId: string, options?: ResolveOptions): Promise<ConfigSnapshot>;
  get(serviceId: string, key: string, options?: GetOptions): Promise<unknown>;
  getNamespace(serviceId: string, prefix: string, options?: GetOptions): Promise<Record<string, unknown>>;
  inspect(serviceId: string, key: string): Promise<ConfigurationInspection>;
  subscribe(serviceId: string, handler: (delta: ConfigDelta) => void): Unsubscribe;
  registerSchema(declaration: ServiceConfigurationDeclaration, environment: string): Promise<void>;
  close(): Promise<void>;
}
```

**Implementations:**

| Implementation | Transport | Use case |
|---|---|---|
| `ScompWeaverTransport` | scomp WebSocket | Backend services (primary) |
| `HttpWeaverTransport` | REST + SSE | Lighter clients, browser, fallback |

The transport choice is a constructor option:
```typescript
const config = createWeaverClient({
  serviceId: "vessel-tracking",
  transport: "scomp",     // or "http"
  url: "ws://weaver:3399/scomp",
  // ... auth options
});
```

#### 9.2 Developer-Facing API

```typescript
const config = createWeaverClient({ ... });

// Synchronous reads from local state (after initial snapshot)
const dbHost = config.get("db.host");
const lynxConfig = config.getNamespace("lynx");
const inspection = config.inspect("db.host");

// Change subscription
config.onChange("db.*", (changes) => { /* react */ });
config.onRestartRequired(() => { /* graceful shutdown */ });

// Tenant-scoped reads
const tenantMaxUsers = config.get("lynx.maxUsers", { tenantId: "acme" });
```

Under the hood:
1. On init: calls `resolveAll` to get full snapshot
2. Subscribes to `configChanges` for live deltas
3. Maintains local state (same `StateContainer` from `@weaver-conf/config-providers`)
4. `get()` is synchronous from local state
5. Deltas update local state and fire `onChange` listeners

#### 9.3 Tenant Loading Modes

Services with `tenantScope: "all"` (e.g., Lynx) need config for multiple tenants. WeaverClient supports three configurable modes:

| Mode | Behavior | Best for |
|---|---|---|
| `lazy` | Load tenant config on first access (async). Cached after first load | Many tenants, sparse access |
| `eager` | Load all tenant configs at startup | Few tenants (< 50), low latency required |
| `hot` | Eager for recently active tenants, lazy for cold tenants. Server tracks activity | Medium scale, balanced latency/memory |

```typescript
const config = createWeaverClient({
  serviceId: "lynx",
  tenantMode: "hot",    // or "lazy" | "eager"
});

// Pre-warm a tenant before serving requests
await config.warmTenant("acme");

// Then sync access
const maxUsers = config.get("lynx.maxUsers", { tenantId: "acme" });
```

The `warmTenant()` method is an async call that ensures the tenant's config is loaded and ready for synchronous access. Services should call this when they know they're about to serve a tenant (e.g., on incoming request, before handler logic).

#### 9.4 Offline Persistence

WeaverClient optionally persists its state locally so it can serve stale config when weaver-server is unreachable. This is critical for offline-first mobile clients and for resilience of backend services.

The persistence layer is pluggable:

```typescript
interface WeaverClientPersistence {
  save(serviceId: string, snapshot: ConfigSnapshot): Promise<void>;
  load(serviceId: string): Promise<ConfigSnapshot | null>;
}
```

**Built-in implementations:**

| Implementation | Backend | Use case |
|---|---|---|
| `FileSystemPersistence` | JSON file on disk | Backend services (Bun/Node) |
| `IndexedDbPersistence` | IndexedDB | Browser clients |

```typescript
const config = createWeaverClient({
  serviceId: "vessel-tracking",
  persistence: new FileSystemPersistence("~/.weaver/cache"),
});
```

Startup with persistence:
1. Load cached snapshot from persistence (if available)
2. Begin serving from cache (stale state)
3. Connect to weaver-server
4. Receive fresh snapshot → overwrite cache → persist new snapshot
5. Resume normal delta streaming

Staleness tracking (exposed to consumers) is a v2 concern. For v1, the client serves whatever state it has without surfacing whether it's fresh or stale.

### 10. Authentication and Authorization

All transports use the **same authentication model**: JWT bearer tokens issued by the Accounts service (OAuth2).

#### Service Authentication (M2M)

Backend services authenticate using OAuth2 **client_credentials** grant:

1. Service has a `client_id` and `client_secret` (provisioned in Accounts)
2. On startup, service exchanges credentials for a JWT at the Accounts token endpoint
3. JWT includes claims: `{ sub: "vessel-tracking", serviceId: "vessel-tracking", scopes: ["config:read"] }`
4. JWT is sent with every request:
   - scomp: `meta.auth` field in the request envelope
   - REST: `Authorization: Bearer <token>` header
   - SSE: `Authorization: Bearer <token>` header on connection

weaver-server validates the JWT signature (using Accounts public key), extracts `serviceId`, and loads the corresponding `ServiceAccessPolicy`.

**Note**: OAuth2 client_credentials support in Accounts is a new capability. See issue weaver-nq3 for the PRD.

#### User Authentication (Admin UI, Browser)

Admin users and browser clients authenticate via OIDC tokens from Accounts:

1. User logs into the Lynx client (OIDC flow via Accounts)
2. Lynx client holds an OIDC access token or id_token
3. The weaver admin MF2 plugin (loaded in Lynx) uses this token for weaver-server requests
4. weaver-server validates the token, extracts user identity and roles
5. Admin operations require roles matching `_weaver.server.adminRoles`

Browser clients accessing public config (feature flags, UI labels) use the same token. weaver-server filters responses by `visibility` — browser clients only see `public` and `admin` visibility values, never `platform` or `internal`.

#### Authorization Flow

```
1. Request arrives with JWT (any transport)
2. Validate JWT signature against Accounts public key
3. Extract identity: serviceId (M2M) or userId + roles (user)
4. For service requests:
   a. Load ServiceAccessPolicy for serviceId
   b. Load ServiceConfigurationDeclaration for serviceId
   c. Compute effective access = declaration ∩ policy
   d. Filter response to only authorized namespaces, keys, tenants
   e. If allowedSecrets=false, strip resolved secrets from response
5. For admin requests:
   a. Check user roles against _weaver.server.adminRoles
   b. Reject if insufficient role
6. For browser requests:
   a. Filter by visibility: public (all users), admin (admin role users)
   b. Never include sensitive values regardless of visibility
```

#### mTLS (Future)

mTLS (mutual TLS) is a future consideration for environments with a service mesh. In mTLS, each service presents a client certificate issued by an internal CA, and the certificate's CN/SAN serves as the service identity — no JWT needed.

This would be supported as an alternative authentication mechanism when a service mesh (Istio, Linkerd) is deployed. The server would extract identity from the client certificate instead of a JWT. Since there is no service mesh in the current Rancher deployment, JWT is the v1 authentication mechanism.

### 11. Change Detection and Delta Streaming

#### Git Change Detection

When config changes in the Git repository (PR merge, direct commit, CI promotion), the server needs to detect and reload.

The detection mechanism is **configurable**:

| Mechanism | Latency | Complexity | Configuration |
|---|---|---|---|
| **Polling** | Seconds (configurable interval) | Low | `_weaver.server.git.pollIntervalMs` |
| **Webhook** | Near-instant | Medium (needs endpoint + GitHub config) | GitHub webhook → `/api/hooks/github` |

Both mechanisms trigger the same reload flow:
1. `git pull` to update local clone
2. Diff changed files against previous state
3. Identify affected layers and environments
4. Reload only affected layers (not full reload)
5. Re-merge affected state
6. Re-resolve mounts and secrets if affected
7. Compute deltas (changed keys + new values)
8. Push deltas to all connected clients subscribed to affected namespaces

#### MongoDB Change Detection

For MongoDB-backed layers (user/device), change detection uses MongoDB **change streams**:

```typescript
collection.watch([{ $match: { "fullDocument.layer": { $in: ["user", "device"] } } }]);
```

Changes trigger the same delta computation and push to connected clients.

#### Delta-Only Streaming

The server pushes **only changed keys** to connected clients. It does not push full snapshots on every change. Each delta includes:

- The changed key
- The new resolved value
- The layer that changed
- The environment
- Timestamp

Clients that fall out of sync (missed deltas due to disconnection) simply request a full snapshot via `resolveAll`. There is no revision-based catch-up protocol or server-side delta buffer. This keeps the server stateless with respect to client connections and simplifies the implementation.

### 12. Rollback and Revision History

#### Rollback API

A first-class rollback operation reverts a bad config change in production:

```
POST /admin/rollback
{
  layer: "platform",
  environment: "production",
  toRevision: "abc123"          ← Git commit hash to revert to
}
```

Rollback flow:
1. Validate the target revision exists in Git history
2. `git revert` the commits from current HEAD back to the target revision
3. `git push` the revert commit
4. Create audit entry: `action: "rollback", fromRevision: current, toRevision: target`
5. Reload affected layers
6. Push deltas to connected clients

**Rollback granularity**: Per commit. A commit may contain multiple key changes (e.g., a promotion that moved several values). Rollback reverts the entire commit. To roll back a single key while keeping other changes from the same commit, the workflow is: rollback the commit, then create a new commit with the desired values re-applied.

**Rollback bypasses changePolicy**: A rollback is always a direct operation, never gated by PR review. The rationale is that a bad production config is an incident — the rollback must be immediate. The audit trail provides accountability.

#### Revision History

The server maintains **revision history per key** for administrative visibility:

- For Git-backed layers: Git history is the source of truth. The server can query `git log` for any file to see the history of changes.
- For MongoDB-backed layers: Each write creates a revision document in a `config_revisions` collection:

```typescript
interface ConfigRevision {
  layer: string;
  environment: string;
  key: string;
  value: unknown;
  previousValue: unknown;
  revision: string;         // auto-generated ID
  timestamp: string;
  actor: string;
}
```

Revision history is available through admin operations (scomp and REST) for troubleshooting and rollback target selection. It is not exposed to regular config consumers.

### 13. Audit System

Every config mutation produces an audit entry. The audit system is **pluggable** with a sink interface:

```typescript
interface ConfigAuditSink {
  record(entry: ConfigAuditEntry): Promise<void>;
}

interface ConfigAuditEntry {
  timestamp: string;
  actor: string;
  action: "set" | "remove" | "promote" | "rollback" | "override" | "provision";
  key: string;
  layer: string;
  environment: string;
  tenantId?: string;
  oldValue?: unknown;          // masked if sensitive
  newValue?: unknown;          // masked if sensitive
  changePolicy?: string;
  promotedFrom?: string;
  isEmergencyOverride: boolean;
  metadata?: Record<string, unknown>;
}
```

**Built-in sinks:**

| Sink | Backend | Use case |
|---|---|---|
| `MongoAuditSink` | MongoDB collection | Queryable audit (v1 default) |
| `StdoutAuditSink` | Structured JSON to stdout | Log shipping to ELK/Loki |

Multiple sinks can be active simultaneously (e.g., MongoDB for querying + stdout for log aggregation).

Audit is **not a config concern** — it has its own storage, its own sink interface, and its own lifecycle. It does not flow through the config layer system.

**Sensitive value masking**: When a key has `x-weaver.sensitive: true`, the audit entry masks `oldValue` and `newValue` (e.g., `"***"` or a hash). Plaintext secret values never appear in audit logs.

**Audit UI**: Querying audit entries from the admin UI is a future concern (noted in Future Considerations). For v1, audit entries are recorded for compliance and can be queried directly from MongoDB or log aggregation tools.

### 14. Tenant Provisioning and Isolation

#### Provisioning

Tenant provisioning is an **API operation** (no manual Git/file touching):

```
POST /admin/tenants
{
  tenantId: "acme",
  displayName: "Acme Corporation"
}
```

Server behavior:
1. Create tenant directory structure in Git:
   ```
   layers/tenant:acme/base/
   ```
2. Materialize default values from all registered `ServiceConfigurationDeclaration`s into the tenant layer. For each service with tenant-applicable config, write default values from the schema's `default` fields into `tenant:acme/base/{namespace}.json`.
3. Commit and push to Git.
4. Reload tenant layer into state container.
5. Create audit entry: `action: "provision"`.

Services with `tenantScope: "all"` in their `ServiceAccessPolicy` automatically see the new tenant. Services with specific tenant lists need a policy update (separate admin operation).

#### Isolation Model

**v1: Shared state container, filtered at serving time.**

All config (all tenants, all layers) is loaded into a single state container per environment. When a service requests config, the server filters by the service's `ServiceAccessPolicy.tenantScope`:

- `tenantScope: "all"` → include all tenant layers in the merge stack
- `tenantScope: ["acme", "globex"]` → include only specified tenant layers

**Safety argument:**

1. Filtering is a **layer-inclusion check**: is this layer ID in the allowed tenant set? This is a simple string-set membership test, not a complex query.
2. The filter runs **on every request** — results are not cached across tenants.
3. Services **never see raw state** — they receive a computed, filtered view.
4. **Unit tests** cover multi-tenant scenarios: verify that a service scoped to tenant A never receives values from tenant B's layer.
5. The layer ID naming convention (`tenant:<id>`) makes tenant boundary violations detectable via code review and static analysis.

**Scale trigger for per-tenant containers**: When tenant count × config size exceeds comfortable per-instance memory, or when regulatory requirements demand process-level isolation. Estimated threshold: 500+ tenants.

#### Per-Request Tenant Scoping

Services with `tenantScope: "all"` (like Lynx) serve multiple tenants. The WeaverClient provides tenant-scoped reads:

```typescript
config.get("lynx.maxUsers", { tenantId: "acme" });
```

On the server side, `resolveAll` for a `tenantScope: "all"` service returns config organized by tenant. The WeaverClient maintains per-tenant merged state and filters locally based on the `tenantId` option.

### 15. Override Sessions

Emergency override sessions allow temporary config changes that bypass normal `changePolicy` restrictions. They are **in scope for v1** but not the highest priority.

```typescript
interface OverrideSession {
  id: string;
  activatedBy: string;
  reason: string;
  activatedAt: string;
  expiresAt: string;            // max duration (e.g., 1 hour)
  overrides: Record<string, unknown>;
  followUpDeadline: string;     // must be regularized within 24h
  regularizedAt?: string;
  regularizedBy?: string;
}
```

Override sessions are **in-memory** (ephemeral by nature):
- Sessions are short-lived (minutes to hours)
- They create an ephemeral layer overlay that takes highest priority
- The `sessionMode` extension on properties controls which keys can be overridden (`allowed`, `restricted`, `blocked`)
- All override writes produce audit entries with `isEmergencyOverride: true`
- After session expiry, overrides are removed and a follow-up deadline is tracked

The follow-up deadline (`activatedAt + 24h`) requires that the emergency change be either regularized (committed through the normal pipeline) or reverted. Tracking compliance with this deadline is a server-side concern — the admin UI will surface overdue follow-ups.

### 16. Health, Observability, and Logging

#### Health Endpoints

Standard Kubernetes health probes via REST:

| Endpoint | Purpose | Behavior |
|---|---|---|
| `GET /healthz` | Liveness | Returns 200 if process is running |
| `GET /readyz` | Readiness | Returns 200 after bootstrap complete, 503 during startup or degraded mode |

#### Logging

weaver-server uses **SLF** (Simple Logging Facade) for structured logging:

```typescript
import { LoggerFactory } from "slf";

const log = LoggerFactory.getLogger("weaver:server:bootstrap");
log.info("Loading layers from %s", repoPath);
log.warn("Config value exceeds 1MB for key %s (%d bytes)", key, size);
```

Named loggers per module: `weaver:server:bootstrap`, `weaver:server:transport`, `weaver:server:git`, `weaver:server:promotion`, `weaver:server:audit`, etc.

Log levels configured via `SLF_LOG_LEVEL` environment variable.

#### Config Value Size Warning

Values exceeding **1MB** trigger a warning:
- **Server-side**: SLF warning logged with key name and size
- **Client-side**: Warning field in the response (e.g., response header or payload metadata)

Values are accepted regardless of size. The warning is informational to catch accidental blob storage.

#### OpenTelemetry

OTel integration (tracing, metrics) is deferred to a later epic. The architecture does not preclude it — SLF can be backed by an OTel-aware driver, and scomp's `meta.traceId` field supports distributed trace propagation.

### 17. Package Structure

weaver-server will be a new package in the weaver monorepo:

```
packages/
  weaver-server/               ← new
    src/
      index.ts                 ← entry point, bootstrap orchestrator
      bootstrap/
        bootstrap-loader.ts    ← reads bootstrap config, resolves env vars
        git-manager.ts         ← clone/pull/commit/push via simple-git
        layer-factory.ts       ← creates storage providers from bootstrap config
      transport/
        scomp-adapter.ts       ← scomp contract implementation
        rest-adapter.ts        ← REST route handlers
        sse-adapter.ts         ← SSE stream handlers
      core/
        config-service.ts      ← core service logic (shared by all transports)
        promotion-engine.ts    ← promotion, rollback, changePolicy enforcement
        schema-registry.ts     ← schema registration, validation, diffing
        tenant-manager.ts      ← tenant provisioning, default materialization
      auth/
        jwt-validator.ts       ← JWT validation, identity extraction
        policy-enforcer.ts     ← ServiceAccessPolicy enforcement
      audit/
        audit-service.ts       ← audit orchestrator
        sinks/
          mongo-sink.ts        ← MongoDB audit sink
          stdout-sink.ts       ← Structured JSON stdout sink
      storage/
        git-storage-provider.ts     ← GitStorageProvider
        mongodb-storage-provider.ts ← MongoDBStorageProvider
    test/
    package.json
    tsconfig.json

  weaver-client/               ← new
    src/
      index.ts
      client.ts                ← createWeaverClient(), WeaverClient class
      transport/
        transport-interface.ts ← WeaverTransport interface
        scomp-transport.ts     ← ScompWeaverTransport
        http-transport.ts      ← HttpWeaverTransport (REST + SSE)
      persistence/
        persistence-interface.ts  ← WeaverClientPersistence interface
        fs-persistence.ts         ← FileSystemPersistence
        indexeddb-persistence.ts  ← IndexedDbPersistence
      tenant/
        tenant-manager.ts      ← lazy/eager/hot tenant loading logic
    test/
    package.json
    tsconfig.json
```

**Dependency graph extension:**

```
config-types (leaf)
    |
    +-- config-engine
    |       |
    |       +-- config-providers
    |       |       |
    |       |       +-- weaver-server (new)
    |       |       |     depends on: config-providers, config-secrets,
    |       |       |                 config-types, config-engine, config-policy
    |       |       |     external: simple-git, mongodb, slf
    |       |       |
    |       |       +-- weaver-client (new)
    |       |             depends on: config-types, config-providers
    |       |             external: slf
    |       |
    |       +-- config-server (existing, distinct from weaver-server)
    |       +-- config-policy
    |
    +-- config-secrets
    +-- config-auth
    +-- config-sync
    +-- config-sessions
```

## Future Considerations

### Audit Log UI

Build a queryable audit viewer in the admin MF2 plugin. Show config change history filtered by key, layer, tenant, actor, time range. Requires the MongoAuditSink backend and an admin API for audit queries. Essential companion to the rollback feature — ops need to see what changed before deciding what to revert.

### OpenTelemetry Integration

Add OTel tracing and metrics to weaver-server. Instrument:
- Bootstrap latency (time to first ready)
- Config resolution latency (per request)
- Delta push latency (change detected to client notified)
- Git pull/push durations
- MongoDB operation durations
- Active client connections (gauge)
- Schema registration events (counter)

Use scomp's `meta.traceId` for distributed trace propagation across service boundaries.

### mTLS Authentication

When a service mesh (Istio, Linkerd) is deployed in Rancher, support mTLS as an alternative authentication mechanism. The server extracts service identity from the client certificate's CN/SAN instead of a JWT. This eliminates token management for M2M auth in mesh-enabled environments.

### Horizontal Scaling

Run multiple weaver-server instances behind a load balancer. Key challenges:
- Each instance has its own in-memory state container
- Write coordination: only one instance should push to Git at a time
- Change propagation: when one instance detects a change, others must reload

Possible approaches:
- **Leader election** for writes (Redis or K8s lease)
- **Shared event bus** (Redis pub/sub or RabbitMQ via scomp transport) for change notification
- **Stateless instances** that all poll Git independently (simplest, slight duplication)

### Repo-Per-Tenant Isolation

For regulatory or contractual requirements demanding hard tenant isolation, split the single config repo into per-tenant repos. The GitStorageProvider already takes a repo URL per layer, so this is a configuration change, not an architecture change.

### WeaverClient Staleness Tracking

Expose freshness state to consuming services:
```typescript
config.isStale();                    // serving from offline cache
config.isReady();                    // fresh snapshot received
config.onReady(() => { ... });       // fires when fresh state loaded
config.lastSyncedAt();               // timestamp of last server sync
```

Enables services to make degraded-mode decisions based on config freshness.

### Expression Marker Resolution

The `_weaver: "expression"` marker (designed in ADR-0001) requires server-side evaluation. weaver-server would need a safe expression engine with sandboxing, built-in functions (`config()`, `env()`), and cycle detection. Deferred pending security review.

### Config Diff Tool

Visual diff between environments: "what's in staging that isn't in production?" Uses the directory-based environment model for straightforward file comparison. Useful for pre-promotion review and post-incident analysis.

### Additional Secret Providers

Extend `SecretProvider` interface with additional implementations:
- `@weaver-conf/config-secrets-aws` — AWS Secrets Manager
- `@weaver-conf/config-secrets-gcp` — Google Cloud Secret Manager
- `@weaver-conf/config-secrets-hashicorp` — HashiCorp Vault

### Declaration Linter

Static analysis tool for `ServiceConfigurationDeclaration` files. Checks for: missing `x-weaver` on sensitive-looking keys, overly broad `reads` patterns, schema version consistency, fragment compatibility. Can run in CI as a pre-merge check.

## Addendum: Gap Analysis Deltas

The following gaps were identified through systematic architecture review and
are incorporated as binding additions to this ADR. They are organized by
severity.

### A.1 Composition with Existing Packages (Critical)

weaver-server and weaver-client do not replace existing domain logic packages.
They compose them as a network transport layer on top of existing libraries:

#### weaver-server Composition

```
weaver-server
  ├── config-providers.createConfigurationService()    ← internal state engine
  │     Uses the same factory that local deployments use.
  │     Storage providers are GitStorageProvider, MongoDBStorageProvider,
  │     and InMemoryStorageProvider (for ephemeral layers).
  │
  ├── config-sessions.createOverrideSessionProvider()  ← override session logic
  │     weaver-server wraps the OverrideSessionController with
  │     API endpoints (activate, deactivate, extend). The domain
  │     logic (expiry, follow-up deadlines) lives in config-sessions.
  │
  ├── config-auth.withAuth()                           ← authorization middleware
  │     JWT authentication extracts identity (serviceId or userId + roles).
  │     The extracted identity is mapped to a ConfigurationAccessContext.
  │     config-auth.canRead() and filterVisibleKeys() evaluate the policy.
  │     weaver-server does NOT reimplement authorization logic.
  │
  ├── config-policy                                    ← write-time validation
  │     Policy rules (sensitive + public = error, changePolicy enforcement)
  │     are evaluated on every write via config-policy validators.
  │
  ├── config-server.FileSystemStorageProvider           ← read path base
  │     GitStorageProvider composes FileSystemStorageProvider for reads
  │     (fs.readFile on JSON files). Git operations (commit, push, PR)
  │     are layered on top for the write path. No read-path duplication.
  │
  └── config-secrets.SecretResolutionService            ← secret resolution
        Same resolution service from ADR-0001. weaver-server calls
        resolveAll() at startup and on secret refresh cycles.
```

#### weaver-client Composition

```
weaver-client
  ├── config-providers.StateContainer                  ← local state cache
  │     WeaverClient maintains a local StateContainer populated from
  │     server snapshots. get() is synchronous from this container.
  │
  ├── config-sync.createConfigSyncOrchestrator()       ← offline sync engine
  │     For offline persistence, WeaverClient wires the sync orchestrator
  │     with a WeaverTransport-backed SyncTransport. The orchestrator
  │     manages snapshot cache, mutation queue, and reconnection logic.
  │     WeaverClientPersistence implementations (fs, IndexedDB) serve
  │     as the durable cache for the sync orchestrator.
  │
  └── config-server.createServiceConfigurationService() ← consumer wrapper
        The developer-facing API. In local mode, it wraps a local
        ConfigurationService. In remote mode, it wraps the WeaverClient.
        Same interface either way — the consumer does not know or care
        whether config comes from local files or weaver-server.
```

#### Interface Continuity

`createServiceConfigurationService()` remains the consumer-facing factory.
Its options gain an optional `transport` field:

```typescript
// Local mode (development, no weaver-server needed)
const config = createServiceConfigurationService({
  serviceId: "vessel-tracking",
  configService: localConfigService,  // from createConfigurationService()
  schema: vesselTrackingSchema,
});

// Remote mode (production, backed by weaver-server)
const config = createServiceConfigurationService({
  serviceId: "vessel-tracking",
  transport: createScompTransport({ url: "ws://weaver:3399/scomp" }),
  schema: vesselTrackingSchema,
});
```

Same `get()`, `getNamespace()`, `inspect()`, `onChange()`, `onRestartRequired()`
interface in both modes. The transport choice is a deployment concern, not a
code concern.

### A.2 Write Operations (Critical)

ADR-0002 section 8 defines read and admin operations but omits the primary
config write path. The following operations are added to both the scomp
contract and REST API:

**scomp operations:**

| Operation | Type | Purpose |
|---|---|---|
| `set` | request | Write a config value to a specific layer and environment |
| `remove` | request | Remove a config key from a specific layer and environment |

**REST endpoints:**

```
PUT    /api/config/:layer/:environment/:key    → set
DELETE /api/config/:layer/:environment/:key    → remove
```

**Write flow:**

```
1. Authenticate request (JWT → identity)
2. Authorize: config-auth.canWrite(identity, layer, key)
3. Validate value against ConfigurationPropertySchema (Zod schema)
4. Check changePolicy:
   a. "direct-allowed" → proceed to write
   b. "staging-gate" or "full-pipeline" → reject if target is
      above the allowed stage (must use promote instead)
   c. "emergency-override" → require active OverrideSession
5. Write to storage provider:
   a. Git-backed: write file, git add, queue for commit/push
   b. MongoDB-backed: upsert document
6. Create audit entry (sensitive values masked)
7. Reload affected layer in state container
8. Compute and push deltas to subscribed clients
```

Write operations for Git-backed layers go through the write serializer
(see A.3). MongoDB writes are independent and do not need serialization.

### A.3 Git Write Serialization (Critical)

All Git write operations are serialized through a single-threaded write
queue to prevent concurrent push conflicts:

```typescript
interface GitWriteQueue {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
}
```

Operations that use the queue:
- `set` / `remove` (for Git-backed layers)
- `promote`
- `rollback`
- `registerSchema` (when schema changes)
- `provisionTenant` / `deprovisionTenant`

Queue behavior:
1. Operations execute one at a time, in FIFO order
2. Before each push: `git pull --rebase` to incorporate external changes
3. If push fails (conflict from external change): retry with rebase (max 3 retries)
4. If retries exhausted: reject the operation, log error, return `GIT_ERROR`
5. Queue depth limit: configurable, default 100. Beyond limit: reject with backpressure

This is sufficient for single-instance v1. Horizontal scaling (future) will
require distributed write coordination (leader election or write-leader model).

### A.4 Error Type Taxonomy (Important)

All operations return structured errors with a code, message, and optional
details. Errors are consistent across scomp and REST transports.

```typescript
interface WeaverError {
  code: WeaverErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

type WeaverErrorCode =
  | "NOT_FOUND"           // key or resource doesn't exist
  | "UNAUTHORIZED"        // invalid, expired, or missing JWT
  | "FORBIDDEN"           // valid JWT but policy denies access
  | "TENANT_NOT_FOUND"    // tenant not provisioned
  | "TENANT_NOT_LOADED"   // tenant not warmed in lazy mode
  | "SCHEMA_CONFLICT"     // breaking schema change rejected by policy
  | "POLICY_VIOLATION"    // changePolicy prevents this write/promote
  | "VALIDATION_ERROR"    // value doesn't match schema
  | "GIT_ERROR"           // Git operation failed after retries
  | "SERVER_DEGRADED"     // serving stale state, writes rejected
  | "SIZE_WARNING"        // value exceeds 1MB (non-fatal, included in response)
  | "QUEUE_FULL"          // Git write queue at capacity
  | "SESSION_REQUIRED"    // operation requires active OverrideSession
  | "SESSION_BLOCKED"     // key's sessionMode is "blocked"
```

REST responses use standard HTTP status codes mapped to error codes:
- `NOT_FOUND` → 404
- `UNAUTHORIZED` → 401
- `FORBIDDEN` → 403
- `VALIDATION_ERROR`, `POLICY_VIOLATION` → 400
- `GIT_ERROR`, `SERVER_DEGRADED` → 503
- `QUEUE_FULL` → 429

### A.5 Schema Validation on Writes (Important)

Every write (`set`, `promote`) validates the value against the key's schema:

1. Look up the `ConfigurationPropertySchema` for the key from the registered
   `ServiceConfigurationDeclaration`
2. If a Zod schema exists: parse the value. Reject with `VALIDATION_ERROR`
   on failure.
3. If no schema is registered for the key: accept the write (schema
   registration may happen later)
4. After layer reload (post-merge): run full schema validation on the
   merged state for the affected service. Log warnings for post-merge
   violations but do not reject (the individual writes were valid;
   the combination is the problem). Surface violations via `inspect()`.

### A.6 Graceful Shutdown Sequence (Important)

On SIGTERM (from Rancher/K8s):

```
1. Set /readyz to false              ← stop receiving new traffic
2. Stop accepting new connections    ← no new scomp/SSE/REST clients
3. Wait for in-flight requests       ← drain with timeout (default 10s)
4. Push final deltas to clients      ← best-effort
5. Close all client connections      ← scomp close, SSE close, HTTP drain
6. Flush audit sink                  ← ensure pending audit entries are written
7. Drain Git write queue             ← complete in-progress writes, cancel queued
8. Close MongoDB connections         ← graceful driver shutdown
9. Cancel background tasks           ← Git polling, secret refresh, session expiry
10. Exit process
```

Configurable drain timeout: `_weaver.server.shutdownDrainMs` (default: 10000).
If drain timeout expires, force-close remaining connections and exit.

### A.7 Tenant Deprovisioning (Important)

Add `deprovisionTenant` to admin operations:

```
POST /admin/tenants/:tenantId/deprovision
{
  archive: true    // false = permanent delete (dangerous)
}
```

Flow:
1. Archive: move `layers/tenant:{id}/` to `layers/_archived/tenant:{id}/`
   in Git. Permanent delete: remove the directory entirely.
2. Remove tenant layer from state container
3. Push deltas to connected services (keys from this tenant disappear)
4. Create audit entry: `action: "deprovision"`
5. Services with `tenantScope` listing this tenant will need policy updates

Archived tenants can be restored by moving the directory back.
Permanent deletion is audited and requires explicit `archive: false`.

### A.8 Service Decommissioning (Important)

Add `decommissionService` to admin operations:

```
POST /admin/services/:serviceId/decommission
{
  archiveConfig: true,     // archive config data in the service's namespace
  archiveSchema: true,     // archive schema
  archivePolicy: true      // archive policy
}
```

Flow:
1. Archive schema: move `_weaver/schemas/{serviceId}.json` to
   `_weaver/_archived/schemas/{serviceId}.json`
2. Archive policy: same pattern
3. Optionally archive config namespace data
4. Create audit entry
5. Note: archived data preserved for historical reference and audit compliance

### A.9 GitHub Webhook Security (Important)

The webhook endpoint (`/api/hooks/github`) must verify request authenticity:

1. GitHub sends `X-Hub-Signature-256` header with HMAC-SHA256 of the payload
2. Server computes HMAC using shared secret (`WEAVER_WEBHOOK_SECRET` env var)
3. Constant-time comparison of signatures
4. Reject with 401 if signature doesn't match
5. Additional: verify `X-GitHub-Event` header matches expected event types
   (`push`, `pull_request`)

The webhook secret is an additional bootstrap environment variable.

### A.10 CORS Configuration (Important)

Browser clients (admin MF2 plugin in Lynx) require CORS headers:

```json
{
  "_weaver.server.cors": {
    "allowedOrigins": ["https://lynx.example.com"],
    "allowedMethods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    "allowCredentials": true,
    "maxAge": 86400
  }
}
```

All REST and SSE responses include appropriate CORS headers.
WebSocket (scomp) connections check the `Origin` header during upgrade.
Default: no CORS (all cross-origin requests rejected) — must be explicitly
configured.

### A.11 JWT Token Lifecycle on Long-Lived Connections (Important)

scomp WebSocket connections are long-lived. JWTs expire.

**Strategy: proactive reconnection.** The WeaverClient tracks its JWT expiry
time. Before the token expires (configurable buffer, default 60 seconds
before expiry), the client:

1. Obtains a fresh JWT from Accounts (token refresh)
2. Disconnects the current scomp connection
3. Reconnects with the new JWT
4. Requests a full snapshot via `resolveAll` (standard reconnection flow)
5. Resumes delta streaming

This reuses the existing reconnection model. No special token refresh
protocol is needed on the wire. The server treats each connection as
independently authenticated.

### A.12 ConfigDelta Delete Events (Important)

The `ConfigDelta` type is extended with an `action` field to distinguish
value changes from deletions:

```typescript
interface ConfigDelta {
  action: "set" | "remove";
  key: string;
  value: unknown | null;    // null when action is "remove"
  layer: string;
  environment: string;
  timestamp: string;
}
```

Clients receiving a `remove` delta must delete the key from local state.

### A.13 Local Development Story (Minor)

In development, services do not need weaver-server. The existing
`createConfigurationService()` with `FileSystemStorageProvider` (or
`StaticJsonProvider`) works directly.

The recommended development workflow:

1. **Unit tests**: Use `InMemoryStorageProvider` with test fixtures
2. **Local dev**: Use `FileSystemStorageProvider` reading from a local
   config directory (can be a clone of the weaver-config repo)
3. **Integration tests**: Use `LocalTransport` — a WeaverTransport
   implementation that wraps `createConfigurationService()` in-process
   (no network, same interface)
4. **Staging/production**: Use `ScompWeaverTransport` or `HttpWeaverTransport`

The `LocalTransport` implementation enables testing the full WeaverClient
code path (tenant loading, persistence, delta handling) without a running
weaver-server.

### A.14 Migration Strategy (Minor)

Migration from direct `ConfigurationStorageProvider` usage to WeaverClient
is incremental and non-breaking:

**Phase 1 — Parallel operation:**
Deploy weaver-server alongside existing config. Services continue using
local storage providers. weaver-server loads the same config repo.

**Phase 2 — HTTP transport adoption:**
Services adopt `createServiceConfigurationService()` with `HttpWeaverTransport`.
Lower risk than scomp (standard HTTP, easier debugging). Local fallback
on transport failure (if offline persistence is configured).

**Phase 3 — scomp transport adoption:**
Services switch to `ScompWeaverTransport` for live delta streaming.
`onChange` listeners now fire in real-time instead of polling.

**Phase 4 — Cleanup:**
Remove local storage providers from service deployments. Services depend
solely on WeaverClient for config. Local `FileSystemStorageProvider` remains
for development.

Each phase is independently deployable and rollbackable. Services can
operate in mixed mode during migration (some on scomp, some on HTTP,
some still local).

### A.15 resolveAll Response Shape for Tenant-All Services (Minor)

For services with `tenantScope: "all"`, the `resolveAll` response uses
explicit tenant separation:

```typescript
interface ConfigSnapshot {
  /** Platform config (non-tenant-scoped) */
  platform: Record<string, unknown>;

  /** Per-tenant config, keyed by tenantId */
  tenants: Record<string, Record<string, unknown>>;

  /** Revision identifier for this snapshot */
  revision: string;

  /** Server timestamp */
  timestamp: string;
}
```

Example:
```json
{
  "platform": {
    "db.host": "prod-db.internal",
    "db.port": 5432
  },
  "tenants": {
    "acme": {
      "lynx.maxUsers": 5000,
      "lynx.theme": "dark"
    },
    "globex": {
      "lynx.maxUsers": 1000,
      "lynx.theme": "light"
    }
  },
  "revision": "abc123",
  "timestamp": "2026-05-02T20:00:00Z"
}
```

The WeaverClient uses this structure to populate per-tenant state
containers. `config.get("lynx.maxUsers", { tenantId: "acme" })` reads
from the `acme` tenant container, falling back to `platform` for keys
without tenant overrides.

For services with specific `tenantScope` (e.g., `["acme"]`), the `tenants`
object contains only the authorized tenants.

### A.16 Schema Default Materialization on Registration (Minor)

When a service registers a schema with new properties that have `default`
values:

1. Server diffs the new schema against the existing schema
2. For each new property with a `default` value:
   a. Check if the key already exists in the appropriate layer
   b. If not: materialize the default into the target layer:
      - Platform-level properties → platform layer base
      - Properties expected per-tenant → each existing tenant layer base
3. Commit materialized defaults to Git
4. Acknowledge registration only after defaults are materialized

This ensures that `resolveAll` after registration always includes the
service's defaults. Without this, a service registering a new property
would get `undefined` for that key until someone manually sets a value.

### A.17 Bootstrap Validation (Minor)

`bootstrap/server.json` is validated at startup using a Zod schema:

```typescript
const BootstrapConfigSchema = z.object({
  layers: z.array(z.object({
    id: z.string(),
    provider: z.enum(["git", "mongodb", "memory"]),
    path: z.string().optional(),
    collection: z.string().optional(),
  })),
  mongodb: z.object({
    uri: z.string(),
  }).optional(),
});
```

Validation failures produce clear error messages:
```
FATAL: Bootstrap validation failed:
  - layers[2].provider: Expected "git" | "mongodb" | "memory", received "gitx"
  - mongodb.uri: Required when any layer uses "mongodb" provider
```

The server exits with code 1 on bootstrap validation failure. No degraded
mode — bootstrap config must be valid.

### A.18 MongoDB Index Strategy (Minor)

Required indexes for MongoDB collections:

**`config_layers` collection:**
```javascript
db.config_layers.createIndex({ layer: 1, environment: 1, key: 1 }, { unique: true })
db.config_layers.createIndex({ layer: 1, environment: 1 })  // for layer scans
```

**`config_revisions` collection:**
```javascript
db.config_revisions.createIndex({ layer: 1, key: 1, timestamp: -1 })
db.config_revisions.createIndex({ timestamp: 1 }, { expireAfterSeconds: 7776000 })  // 90-day TTL
```

**`config_audit` collection:**
```javascript
db.config_audit.createIndex({ timestamp: -1, layer: 1 })
db.config_audit.createIndex({ timestamp: -1, tenantId: 1 })
db.config_audit.createIndex({ key: 1, timestamp: -1 })
```

Indexes are created at startup if they don't exist (idempotent
`createIndex` calls). The revision TTL index auto-expires old revision
history after 90 days (configurable via `_weaver.server.revisionRetentionDays`).

### A.19 GitStorageProvider and FileSystemStorageProvider Relationship (Minor)

`GitStorageProvider` composes `FileSystemStorageProvider` for reads rather
than duplicating filesystem logic:

```typescript
class GitStorageProvider implements ConfigurationStorageProvider {
  private readonly fsProvider: FileSystemStorageProvider;
  private readonly git: SimpleGit;
  private readonly writeQueue: GitWriteQueue;

  async load(): Promise<ConfigurationLayerData> {
    // Delegate reads to FileSystemStorageProvider
    return this.fsProvider.load();
  }

  async write(key: string, value: unknown): Promise<WriteResult> {
    return this.writeQueue.enqueue(async () => {
      // Write file via fsProvider
      const result = await this.fsProvider.write(key, value);
      // Then commit and push via Git
      await this.git.add(this.fsProvider.pathForKey(key));
      await this.git.commit(`config: set ${key}`);
      await this.git.push();
      return result;
    });
  }
}
```

`FileSystemStorageProvider` remains available independently for local
development and testing (no Git required).

### A.20 scomp Contract Versioning (Minor)

The scomp contract is versioned via the contract token name:

```typescript
const WeaverConfigV1 = createContractToken<WeaverConfigContractV1>("weaver-config-v1");
```

Breaking changes to the contract create a new token:
```typescript
const WeaverConfigV2 = createContractToken<WeaverConfigContractV2>("weaver-config-v2");
```

During migration, the server hosts both contract versions simultaneously.
Clients negotiate the available version via scomp's built-in
`__scomp.discover` control plane route. Old clients continue using v1
until migrated. After migration window: v1 is removed.

Non-breaking additions (new operations) do not require a version bump —
old clients simply don't call the new operations.

## Addendum B: Architectural Redesign

The following items (B.1–B.9) capture binding architectural decisions made after the original ADR and Addendum A were written. They are the result of deep analysis of the existing codebase and industry research across Consul, etcd, Azure App Configuration, LaunchDarkly, SpiceDB, OpenFGA, and Ory Keto. Each item explicitly states which original ADR sections it supersedes.

---

### B.1 Scope-Only Model — Kill Tenant Abstraction

**Severity**: Critical

**Supersedes**: ADR sections 9.3, 14, A.7, A.15

**Decision**: Replace all `tenantId` / `tenantScope` / `TenantManager` references with a generic scope model built on `ScopeInstance[]` and `ScopeDefinition` — types that already exist in `@weaver-conf/config-types` but are underused.

**Context**: The layer naming convention already works generically. Providers named `tenant:acme`, `site:oslo`, `user:u123` encode scope via `{scopeId}:{value}`. The codebase special-cases `tenant` throughout — `isTenantLayer()`, `extractTenantId()`, `warmTenant()`, `TENANT_NOT_FOUND` — but the underlying resolution engine treats all scoped layers uniformly. Tenant is just one scope dimension.

**What changes**:

| Location | Original ADR | Redesign |
|---|---|---|
| `ConfigurationContext` | `tenantId: string` + `scopePath: ScopeInstance[]` | `scopePath: ScopeInstance[]` only |
| `ConfigSnapshot` | `{ platform, tenants: Record<string, ...> }` | `{ entries: Record<string, unknown>, scopes: Record<string, Record<string, Record<string, unknown>>>, revision, timestamp }` — scopes keyed by scope path string (e.g. `"tenant:stenaline"`, `"tenant:stenaline/site:oslo"`) |
| `WeaverConfigService` methods | `options?: { tenantId?: string }` | `options?: { scopePath?: ScopeInstance[] }` |
| `WeaverTransport.resolveAll` | `ResolveOptions { tenantId?: string }` | `ResolveOptions { scopePath?: ScopeInstance[] }` |
| `TenantManager` (server) | Scans `tenant:*` providers | `ScopeManager` — scans `{scopeId}:*` for any scope dimension |
| `TenantManager` (client) | `warmTenant(id)` | `preloadScope(scopePath: ScopeInstance[])` |
| `ResolutionContext` | `tenantId` + `scopeInstances` | `scopeInstances` only |
| REST routes | `?tenantId=` | `?scope=tenant:stenaline,site:oslo` |
| `isTenantLayer()` / `extractTenantId()` | Hardcoded `"tenant:"` prefix | Generic `parseScopeLayer(layer) → { scopeId, value }` |
| Error codes | `TENANT_NOT_FOUND`, `TENANT_NOT_LOADED` | `SCOPE_NOT_FOUND`, `SCOPE_NOT_LOADED` |
| Server provisioning | `provisionTenant` / `deprovisionTenant` | `provisionScope` / `deprovisionScope` |

**Scope loading strategies** replace tenant loading modes:

```typescript
const config = createWeaverClient({
  scopeLoading: "lazy",  // load on first getForScope(), cache after
  // or "eager" — load all known scope values on startup
  // or { strategy: "eager", scopes: ["tenant"] } — eager for specific scope types
});

// Pre-load specific scope path
await config.preloadScope([
  { scopeId: "tenant", value: "stenaline" },
  { scopeId: "site", value: "gothenburg" },
]);
```

**Rationale**: `ScopeInstance` and `ScopeDefinition` already exist in `@weaver-conf/config-types`. The resolution engine already handles arbitrary scope layers. The only thing that special-cases tenant is the surrounding infrastructure — manager classes, error codes, client convenience methods, and REST parameters. Removing the special case eliminates a category of code that would need to be duplicated for every new scope dimension (site, region, user, environment group).

---

### B.2 Namespace Auto-Prefix — Kill serviceId

**Severity**: Critical

**Supersedes**: ADR sections 8.1, 8.2, 9.1, 9.2, A.1

**Decision**: Remove `serviceId` from all transport methods and REST paths. Replace with `namespace` — a key prefix that the client auto-applies.

**Context**: `serviceId` is currently a no-op on the server — accepted as `_serviceId` (underscored, unused). The server returns ALL keys regardless of the `serviceId` passed. It should never have been a parameter on transport methods. What services actually need is key namespacing — "my keys live under `services.accounts.*`" — which is a client-side concern.

**Client construction**:

```typescript
const config = createWeaverClient({
  namespace: "services.accounts",   // just a key prefix, not a magic ID
  transport: createHttpTransport({ baseUrl: "https://weaver.internal" }),
});

// Reads are auto-prefixed
config.get("auth.ttl");           // → resolves "services.accounts.auth.ttl"

// Absolute path breaks out (for declared cross-namespace reads)
config.get("/platform.features.mfa");  // → resolves "platform.features.mfa"
```

**Transport interface change**: All `WeaverTransport` methods lose the `serviceId` parameter:

```typescript
interface WeaverTransport {
  resolveAll(options?: ResolveOptions): Promise<ConfigSnapshot>;
  get(key: string, options?: GetOptions): Promise<unknown>;
  // ... etc
}
```

**Access control**: The server enforces access through `ServiceAccessPolicy.allowedPaths` — the client asks for keys, the server filters by what the caller's JWT identity is allowed to read. Namespace is a client convenience, not a security boundary.

**Rationale**: Removing a parameter that is universally ignored on the server eliminates a false contract. Namespace-as-prefix is how Consul, etcd, and Azure App Configuration handle multi-service key spaces — the key space is flat, and services use prefixes by convention, not by API parameter.

---

### B.3 World-Class REST API

**Severity**: Critical

**Supersedes**: ADR section 8.2

**Decision**: Redesign the REST API following industry best practices from Consul KV, etcd v3, Azure App Configuration, LaunchDarkly, and Zanzibar-family systems.

**Context**: The original REST API had path asymmetry (reads by `serviceId`, writes by layer/environment), no API versioning, and no standard concurrency control. The redesign uses a flat key space with query parameters, consistent response envelopes, and ETags.

**Endpoint design**:

```
# ── Config reads ──────────────────────────────────────────
GET /v1/config                                    → all config (admin only)
GET /v1/config?prefix=services.accounts           → filter by prefix
GET /v1/config?prefix=services.accounts&scope=tenant:stenaline,site:oslo
GET /v1/config/{key}                              → single key value
GET /v1/config/{key}?scope=tenant:stenaline       → scoped value
GET /v1/config/{key}?inspect                      → layer provenance
GET /v1/config/{key}?layer=platform               → value at specific layer

# ── Config writes ─────────────────────────────────────────
PUT    /v1/config/{key}                           → set (default write layer)
PUT    /v1/config/{key}?layer=tenant:stenaline    → explicit layer
PUT    /v1/config/{key}?env=staging               → explicit environment
DELETE /v1/config/{key}                           → remove (default layer)
DELETE /v1/config/{key}?layer=platform            → explicit layer

# ── Change streaming (SSE) ────────────────────────────────
GET /v1/events                                    → all changes
GET /v1/events?prefix=services.accounts           → filtered
GET /v1/events?prefix=services.accounts&scope=tenant:stenaline
GET /v1/events?since=rev-42                       → resume from revision

# ── Scopes ────────────────────────────────────────────────
GET /v1/scopes                                    → list scope definitions
GET /v1/scopes/{scopeId}                          → list values for a scope
GET /v1/scopes/{scopeId}?parent=tenant:stenaline  → filtered by parent

# ── Admin ─────────────────────────────────────────────────
POST   /v1/admin/promote                          → promote across environments
POST   /v1/admin/rollback                         → revert to revision
POST   /v1/admin/schemas                          → register service schema
GET    /v1/admin/schemas/{namespace}              → get schema
POST   /v1/admin/scopes/{scopeId}                 → provision scope value
DELETE /v1/admin/scopes/{scopeId}/{value}          → deprovision

# ── Sessions (emergency overrides) ────────────────────────
POST   /v1/admin/sessions                         → activate override session
GET    /v1/admin/sessions/active                   → current session
DELETE /v1/admin/sessions/active                   → deactivate
```

**Response envelope** (consistent across all endpoints):

```json
{
  "data": { ... },
  "meta": { "revision": "rev-42", "timestamp": "2026-05-03T..." }
}
```

**Headers**:
- `ETag: "rev-42"` on every response
- `If-Match: "rev-42"` for CAS on writes → `409 Conflict` on mismatch
- `Cache-Control: no-cache`

**Default write layer** inferred from caller identity:
- Service identity → `platform` layer
- User identity → `user` layer
- Admin identity → `platform` layer (overridable via `?layer=`)
- Can be overridden in `ServiceAccessPolicy`

Same for environment — defaults to server's `WEAVER_ENVIRONMENT`, overridable via `?env=`.

**Design principles adopted**:

| Principle | Source | Applied As |
|---|---|---|
| Flat key space, prefix queries | Consul, etcd, Azure | `/v1/config/{key}` + `?prefix=` |
| ETags on every response | Azure App Configuration | `ETag: "rev-42"` header |
| CAS via If-Match | Azure, Consul | `If-Match` on writes |
| SSE with snapshot/patch/checkpoint events | LaunchDarkly | `event: snapshot`, `event: change`, `event: checkpoint` |
| Resumable watch via cursor | SpiceDB, etcd | `?since=rev-42` on SSE |
| Consistent response envelope | Universal | `{ data, meta: { revision, timestamp } }` |
| API versioning in path | Azure | `/v1/` prefix |
| Scope enumeration via reflection | SpiceDB, OpenFGA | `/v1/scopes/{scopeId}` |
| Default write target from identity | AWS AppConfig | Server infers layer from JWT role |

**Rationale**: The original API's path-based `serviceId` routing conflated client identity with key namespacing. Industry consensus is flat key space + prefix filtering + identity-based access control. The `/v1/` prefix enables non-breaking API evolution. The response envelope and ETag pattern are table stakes for production configuration APIs.

---

### B.4 WeaverTransport Write Operations

**Severity**: Critical

**Supersedes**: ADR section 9.1

**Decision**: Add `set()` and `remove()` to `WeaverTransport`. The original ADR defined `WeaverTransport` as read-only. This blocks config-sync consolidation (B.6) and WeaverClient write capabilities (B.5).

**Revised interface**:

```typescript
interface WeaverTransport {
  // ── Reads (unchanged) ──
  resolveAll(options?: ResolveOptions): Promise<ConfigSnapshot>;
  get(key: string, options?: GetOptions): Promise<unknown>;
  getNamespace(prefix: string, options?: GetOptions): Promise<Record<string, unknown>>;
  inspect(key: string): Promise<ConfigurationInspection>;
  subscribe(handler: (delta: ConfigDelta) => void, options?: SubscribeOptions): Unsubscribe;

  // ── Writes (NEW) ──
  set(key: string, value: unknown, options?: WriteOptions): Promise<WriteResult>;
  remove(key: string, options?: WriteOptions): Promise<WriteResult>;

  // ── Scopes (NEW) ──
  listScopes(): Promise<ScopeDefinition[]>;
  listScopeValues(scopeId: string, parentScope?: ScopeInstance[]): Promise<string[]>;

  // ── Admin (unchanged) ──
  registerSchema(declaration: ServiceConfigurationDeclaration, environment: string): Promise<void>;

  // ── Lifecycle ──
  close(): Promise<void>;
}

interface WriteOptions {
  layer?: string;         // default: inferred from identity on server
  environment?: string;   // default: server's current environment
  ifRevision?: string;    // optimistic concurrency (CAS)
}

interface WriteResult {
  success: boolean;
  revision?: string;      // new revision after write
  error?: WeaverError;
}
```

All three transport implementations (`ScompWeaverTransport`, `HttpWeaverTransport`, `LocalTransport`) implement the full interface. `LocalTransport` delegates writes to the in-process `ConfigurationService`.

Note: `serviceId` is removed from all method signatures per B.2.

**Rationale**: A read-only transport forces config-sync to maintain a parallel write path, and prevents WeaverClient from offering write operations for admin UIs. Adding writes to the transport unifies the data path.

---

### B.5 Revised WeaverClient Interface

**Severity**: Critical

**Supersedes**: ADR sections 9.2, 9.3, 9.4

**Decision**: Redesign WeaverClient to use `@weaver-conf/config-types` (not parallel types), add write operations, scope-aware reads, admin capabilities, and generics.

**Context**: The existing WeaverClient defines its own `ConfigDelta`, `ConfigSnapshot`, `GetOptions` in a local `types.ts`. These duplicate types from `@weaver-conf/config-types` and will drift. Client-specific concerns (persistence options, transport selection) stay local; shared domain types must be imported.

**Revised interface**:

```typescript
interface WeaverClient {
  // ── Reads (sync, from local state) ──
  get<T>(key: string): T | undefined;
  get<T>(key: string, scopePath: ScopeInstance[]): T | undefined;
  getWithDefault<T>(key: string, defaultValue: T): T;
  getWithDefault<T>(key: string, defaultValue: T, scopePath: ScopeInstance[]): T;
  getAtLayer<T>(layer: string, key: string): T | undefined;
  getNamespace(prefix: string): Record<string, unknown>;
  getNamespace(prefix: string, scopePath: ScopeInstance[]): Record<string, unknown>;
  getForScope<T>(key: string, scopePath: ScopeInstance[]): T | undefined;

  // ── Inspection (async, server round-trip) ──
  inspect<T>(key: string): Promise<ConfigurationInspection<T>>;

  // ── Writes (async, goes to server) ──
  set(key: string, value: unknown, options?: WriteOptions): Promise<WriteResult>;
  remove(key: string, options?: WriteOptions): Promise<WriteResult>;

  // ── Scopes ──
  listScopes(): Promise<ScopeDefinition[]>;
  listScopeValues(scopeId: string, parentScope?: ScopeInstance[]): Promise<string[]>;
  preloadScope(scopePath: ScopeInstance[]): Promise<void>;

  // ── Change tracking ──
  onChange(pattern: string, handler: (changes: ConfigDelta[]) => void): Unsubscribe;
  onRestartRequired(handler: () => void): Unsubscribe;
  readonly pendingRestart: boolean;

  // ── Health ──
  readonly revision: string;
  readonly connected: boolean;
  readonly lastSyncedAt: Date | null;
  readonly staleSince: Date | null;

  // ── Lifecycle ──
  close(): Promise<void>;
}
```

**Key changes from original ADR**:

- No `serviceId` parameter — namespace auto-prefix handles this (B.2)
- `warmTenant()` → `preloadScope(scopePath)` (B.1)
- `tenantMode` → `scopeLoading` (B.1)
- Generics `<T>` on all read methods (aligns with `ConfigurationService`)
- `getWithDefault<T>()`, `getForScope<T>()`, `getAtLayer<T>()` added (from `ConfigurationService`)
- `set()` and `remove()` for write operations (enables admin UI)
- `listScopes()`, `listScopeValues()` for scope enumeration (B.7)
- `inspect<T>()` for admin/debugging (layer provenance)
- Health properties: `connected`, `lastSyncedAt`, `staleSince` (was deferred to v2 in original ADR, now v1)
- All types imported from `@weaver-conf/config-types` — no parallel type definitions

**One client, not separate SDKs**: Admin operations (`getAtLayer`, `set`, `remove`, session ops) are gated by JWT role on the server, not by separate client classes. A regular service calling `set()` gets `FORBIDDEN` if its policy doesn't allow writes.

**Rationale**: The original client interface was designed before the transport had write capabilities and before the scope model was generalized. The revised interface aligns with `ConfigurationService`'s method signatures (generics, `getWithDefault`, `getAtLayer`) and eliminates the type duplication problem identified in A.1.

---

### B.6 config-sync Over WeaverTransport

**Severity**: Important

**Supersedes**: ADR A.1 (re: config-sync composition)

**Decision**: config-sync should use `WeaverTransport` as its backing transport, not a separate `ConfigSyncTransport` interface. A thin adapter bridges the interface gap.

**Context**: config-sync currently defines `ConfigSyncTransport` with `pull({cursor})`, `push({mutations[]})`, and `ack({requestId})`. With write operations now on `WeaverTransport` (B.4), these map cleanly:

| config-sync needs | WeaverTransport provides | Adapter strategy |
|---|---|---|
| `pull({cursor})` → delta changes | `resolveAll()` → full snapshot | Snapshot diff against local state |
| `push({mutations[]})` → per-mutation accept/reject | `set()` / `remove()` (B.4) | Loop over mutations |
| `ack({requestId})` → confirm receipt | Nothing needed | No-op (server has no transaction to release) |

**Adapter implementation**:

```typescript
function createWeaverSyncTransport(transport: WeaverTransport): ConfigSyncTransport {
  return {
    async pull(cursor) {
      const snapshot = await transport.resolveAll();
      return diffAgainstLocal(snapshot, cursor);
    },
    async push(mutations) {
      const results = [];
      for (const mutation of mutations) {
        if (mutation.action === "set") {
          results.push(await transport.set(mutation.key, mutation.value));
        } else {
          results.push(await transport.remove(mutation.key));
        }
      }
      return results;
    },
    async ack() { /* no-op */ },
  };
}
```

**Trade-off on conflict detection**: config-sync has per-key `baseRevision` conflict detection. The server tracks a global revision, not per-key revisions. `WriteResult` returns `{ success, revision }` with a global revision.

**Decision**: Use global revision for optimistic concurrency. This is sufficient because config writes are low-frequency. Per-key revision tracking (like Azure App Configuration / etcd) can be added later when multi-writer admin tools require it.

**Rationale**: Maintaining two parallel transport abstractions (`WeaverTransport` and `ConfigSyncTransport`) that talk to the same server creates unnecessary indirection and duplicated connection management. The adapter pattern lets config-sync consume WeaverTransport without changing config-sync's internal architecture.

---

### B.7 Scope Enumeration API

**Severity**: Important

**Not in original ADR** — this is net-new capability.

**Decision**: Add scope enumeration to both server and client. Clients need to discover available scope values (e.g., "which tenants exist?", "which sites does this tenant have?").

**Server API**:

```
GET /v1/scopes                                → { definitions: ScopeDefinition[] }
GET /v1/scopes/tenant                         → { values: ["stenaline", "dfds", "viking"] }
GET /v1/scopes/site?parent=tenant:stenaline   → { values: ["gothenburg", "oslo"] }
```

**scomp operations**:

| Operation | Type | Purpose |
|---|---|---|
| `listScopes` | request | List scope definitions (what dimensions exist) |
| `listScopeValues` | request | List values for a scope (optionally filtered by parent) |

**WeaverClient methods**:

```typescript
client.listScopes(): Promise<ScopeDefinition[]>;
client.listScopeValues(scopeId: string, parentScope?: ScopeInstance[]): Promise<string[]>;
```

**Server implementation** — `ScopeManager` (replaces `TenantManager`):

```typescript
function listScopeValues(scopeId: string): string[] {
  return providers
    .filter(p => p.layer.startsWith(`${scopeId}:`))
    .map(p => p.layer.slice(scopeId.length + 1));
}
```

The data already exists implicitly — scope values are derivable from provider layer names. `ScopeDefinition.parentScopeId` enables hierarchical filtering (e.g., `site` values under a specific `tenant`).

**Rationale**: Inspired by SpiceDB's `LookupResources` and OpenFGA's `ListObjects` — answer "what's available?" through schema reflection, not data queries. Admin UIs and onboarding flows need to enumerate scopes without hardcoding known values.

---

### B.8 SSE Event Model

**Severity**: Important

**Supersedes**: ADR section 8.3

**Decision**: Adopt the LaunchDarkly/SpiceDB Watch pattern for SSE streaming with three event types and resumable cursors.

**Context**: The original SSE design was a simple delta stream with no reconnection protocol. Clients had to call `resolveAll()` on reconnect to re-establish state, creating a thundering-herd risk on server restarts.

**Endpoint**:

```
GET /v1/events?prefix=services.accounts&scope=tenant:stenaline&since=rev-42
```

**Event types**:

```
event: snapshot
data: {"entries":{"auth.ttl":3600,"db.host":"prod.internal"},"revision":"rev-45"}

event: change
data: {"key":"auth.ttl","value":7200,"action":"set","revision":"rev-46","layer":"platform","environment":"production","timestamp":"2026-05-03T12:00:00Z"}

event: checkpoint
data: {"revision":"rev-46"}
```

- **`snapshot`** — full state on first connect or when client is too far behind to catch up via deltas
- **`change`** — individual key change with full provenance (same shape as `ConfigDelta`)
- **`checkpoint`** — periodic keepalive with current revision (keeps connection alive, gives client a resumption point)

**Resumable streaming**: `?since=rev-42` enables reconnection without full re-fetch. On reconnect, the client sends its last known revision. If the server can provide deltas from that point, it sends `change` events. If not (revision too old, or server restart), it sends a full `snapshot` event first.

This replaces the original "client must call `resolveAll` on reconnect" model. Clients still CAN call `resolveAll` explicitly, but the SSE endpoint handles reconnection gracefully on its own.

**Rationale**: LaunchDarkly's streaming SDK and SpiceDB's `Watch` API both use this three-event pattern. It eliminates the thundering-herd problem on reconnect, provides natural keepalive via checkpoints, and gives clients a single connection that handles both initial state and ongoing updates.

---

### B.9 ETag/CAS Pattern

**Severity**: Important

**Not in original ADR** — this is net-new capability.

**Decision**: Adopt the Azure App Configuration / Consul pattern of ETag-based optimistic concurrency on all endpoints.

**Every response includes**:

```
ETag: "rev-42"
```

**Write operations accept**:

```
If-Match: "rev-42"     → CAS: only write if current revision matches
If-None-Match: "*"     → only write if key doesn't exist (create-only)
```

**On mismatch**: `409 Conflict` with body:

```json
{
  "data": null,
  "meta": { "revision": "rev-43", "timestamp": "..." },
  "error": { "code": "REVISION_CONFLICT", "message": "Expected revision rev-42, current is rev-43" }
}
```

New error code `REVISION_CONFLICT` added to `WeaverErrorCode`.

**Revision model**: This uses **global revision** (not per-key). The revision is a Git commit hash (for Git-backed layers) or an auto-incrementing counter (for MongoDB layers). This is sufficient for v1 where config writes are low-frequency and typically single-writer.

Per-key revision tracking (like Azure App Configuration's per-key ETags) is a future enhancement for multi-writer scenarios.

**Rationale**: Optimistic concurrency control is table stakes for any configuration API that supports writes. Without it, concurrent admin operations silently overwrite each other. The ETag/If-Match pattern is an HTTP standard (RFC 7232) and is used by Azure App Configuration, Consul, and etcd's revision-based watches. Global revision is the simplest correct implementation and matches the existing `ConfigSnapshot.revision` field.

## Consequences

- New `@weaver-conf/weaver-server` package: central config server with Git + MongoDB storage, scomp/REST/SSE transports, JWT auth, promotion engine, rollback API, pluggable audit
- New `@weaver-conf/weaver-client` package: high-level client with pluggable transport (scomp or HTTP/SSE), tenant modes (lazy/eager/hot), offline persistence
- New dependencies: `simple-git`, `mongodb` (native driver), `slf`, `gh` CLI (runtime)
- New dependency on `@scomp/core` and `@scomp/transport-websocket-server` for the scomp transport layer
- `@weaver-conf/config-types` gains `WeaverTransport` interface and `ConfigDelta` type
- Requires a dedicated Git repository (`weaver-config`) for configuration storage
- Requires MongoDB instance for user/device layers and audit
- Requires Accounts service to support OAuth2 client_credentials grant (new capability, see weaver-nq3)
- Breaking change: services must migrate from direct `ConfigurationStorageProvider` usage to WeaverClient for production deployments
- Single-server deployment for v1; horizontal scaling deferred but architecture supports it
- All existing packages (`config-engine`, `config-providers`, `config-secrets`, `config-policy`) remain unchanged — weaver-server builds on top of them
- Addendum A.1–A.20: 20 gap analysis deltas addressing package composition, write operations, Git concurrency, error handling, validation, shutdown, lifecycle management, security, and developer experience
- Existing packages (`config-server`, `config-sync`, `config-sessions`, `config-auth`) are composed into weaver-server/weaver-client, not superseded — see addendum A.1
- Addendum B.1–B.9: 9 architectural redesign deltas addressing scope model generalization, namespace auto-prefix, REST API redesign, transport write operations, WeaverClient interface revision, config-sync consolidation, scope enumeration, SSE event model, and ETag/CAS concurrency control
