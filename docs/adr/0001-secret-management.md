# ADR-0001: Weaver Marker Architecture, Secret Management, and Service Configuration

> **Historical API examples:** the environment-overlay/provenance wrapper exports and bootstrap snippets below describe earlier proposals, not supported current APIs. Marker/secret-management concepts remain relevant; current schema-governed startup and provenance use the [seed bootstrap guide](../guides/bootstrap-config-repo.md) and canonical pipeline.

> **Status**: Accepted. Note: packages `config-providers` and `config-server` referenced in this ADR were consolidated into `weaver-server` in Phase 1 (May 2026).

- **Status**: Accepted
- **Date**: 2026-05-02
- **Epic**: weaver-edj

## Context

Weaver is a multi-tenant B2B configuration management system serving a platform
with infrastructure services (Sentinel authorization, Accounts authentication),
a multi-tenant application (Lynx terminal operating system), and 50+ domain
services. Enterprise customers require secure handling of sensitive configuration
values (database credentials, API keys, JWT signing keys, certificates) that must
never be stored in plaintext alongside regular configuration.

Additionally, the platform requires:

- Shared infrastructure config (database clusters, platform certificates) that
  multiple services reference
- Per-tenant secret overrides (each tenant may have its own signing keys, SMTP
  credentials, etc.)
- Multi-site scoping (tenant config varies by geographic site)
- Service-scoped config access (each service sees only its declared namespace)
- Dynamic schema registration (services declare their config contracts at runtime)
- Plugin/module architecture support (100+ plugins with independent config lifecycles)
- Environment management (dev, staging, production) with clean promotion paths
- Platform ops authorization for service access control

Today, Weaver has foundational building blocks:

- A `sensitive` boolean flag on `ConfigurationPropertySchema` (metadata-only)
- Policy validation flagging security-sensitive key names
- A visibility system (`public`, `admin`, `platform`, `internal`)
- Pluggable `ConfigurationStorageProvider` interface
- Namespace-scoped `ServiceConfigurationService` for backend M2M config
- `ServiceConfigurationDeclaration` for declaring service config contracts
- A consumer-configurable layer stack via `defineWeaver()`
- A `FileSystemStorageProvider` with basic environment overlay support

What is missing: vault integration, the `_weaver` marker system for reference
types, config mount/indirection, runtime schema registration, the `x-weaver`
property extension namespace, service access policies, environment-aware storage,
schema fragments for plugin architectures, and bracket notation for compound key
identifiers.

## Decision

### 1. The `_weaver` Marker System

Weaver introduces a **marker system** for config values that require special
resolution. A marker is a JSON object with a `_weaver` discriminant field that
identifies its type. The resolution engine processes markers after layer merging,
resolving them into their final values.

```typescript
type WeaverMarker = SecretReference | ConfigMount;

function isWeaverMarker(value: unknown): value is WeaverMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    "_weaver" in value &&
    typeof (value as Record<string, unknown>)["_weaver"] === "string"
  );
}
```

The `_weaver` discriminant is:

- **Document-store safe**: No `$` prefix (reserved in MongoDB). No escaping
  needed in any storage backend.
- **Extensible**: Future marker types (expressions, feature flags) use the same
  discriminant with different string values.
- **Structurally detectable**: `isWeaverMarker()` checks a single property,
  then dispatches by `_weaver` value.

v1 marker types:

| `_weaver` value | Type | Purpose |
|---|---|---|
| `"secret-ref"` | `SecretReference` | Points to a secret in an external vault |
| `"mount"` | `ConfigMount` | Redirects a key or namespace to another config path |

Future marker types (designed, not built in v1):

| `_weaver` value | Type | Purpose |
|---|---|---|
| `"expression"` | `ConfigExpression` | Dynamic value computed from other config keys/context |

### 2. SecretReference: References, Not Values

Configuration layers store **secret references**, never plaintext secret values.

```typescript
interface SecretReference {
  readonly _weaver: "secret-ref";
  readonly provider: string;    // "azure-keyvault", "aws-secrets-manager", ...
  readonly uri: string;         // provider-specific locator
  readonly version?: string;    // pin to specific secret version
}
```

Resolution from reference to plaintext happens **server-side only**, at service
startup, via a `SecretResolutionService` with a TTL cache and background refresh.

The `uri` field is fully decoupled from the Weaver config key name. This enables
zero-rename integration with legacy vault secrets.

#### Architecture: SecretReference Model (vs. Vault-as-Provider)

Two architectures were evaluated:

**A. Vault as ConfigurationStorageProvider** (from Accounts PRD): Azure Key Vault
implements the existing `ConfigurationStorageProvider` interface. Secrets load
into the state container as plaintext values in a "secrets" layer.

**B. SecretReference + Resolution Layer** (this ADR): Config layers store
reference objects pointing to vault secrets. Resolution happens server-side.

We chose **Approach B** because:

| Concern | Vault-as-Provider (A) | SecretReference (B) |
|---|---|---|
| Plaintext in state container | Yes | Never -- references only |
| Admin visibility | Plaintext via inspect() | Vault metadata (provider, URI, version) |
| Secret naming freedom | Convention-based naming required | URI decoupled from config key |
| Legacy bridging | Must rename vault secrets | Zero rename |
| Sync safety | Plaintext could leak | Safe by design |
| Marker system fit | N/A | Natural first marker type |

#### Dual-Layer State: Shadow Map

The state container stores raw marker objects. Resolution caches live separately:

```
State Container (rawLayers):
  "lynx.db":      { _weaver: "mount", source: "db.clusters.alpha" }
  "db.clusters.alpha.connectionString": { _weaver: "secret-ref", ... }

Mount Map:
  "lynx.db." -> "db.clusters.alpha."

Secret Cache:
  "db.clusters.alpha.connectionString" -> "Server=sql-alpha-1..."

get("lynx.db.connectionString"):
  1. Mount rewrite: "lynx.db.connectionString" -> "db.clusters.alpha.connectionString"
  2. Secret cache hit -> return plaintext
```

Plaintext never enters state container, sync pipeline, or layer inspection.

### 3. ConfigMount: Namespace and Key Indirection

A mount redirects a config key (or namespace prefix) to another location in the
config tree.

```typescript
interface ConfigMount {
  readonly _weaver: "mount";
  readonly source: string;    // source key or namespace prefix
}
```

**Namespace mount** (redirects an entire sub-namespace):

```json
{ "lynx.db": { "_weaver": "mount", "source": "db.clusters.alpha" } }
```

`get("lynx.db.hosts")` resolves to `get("db.clusters.alpha.hosts")`.

**Per-tenant mount override** via standard layer merging:

```
platform layer:      lynx.db -> mount to db.clusters.alpha
tenant:globex layer: lynx.db -> mount to db.clusters.beta
```

**Mount + secret chaining**:

```
lynx.db.connectionString
  -> mount resolves -> db.clusters.alpha.connectionString
  -> value is { _weaver: "secret-ref", provider: "azure-kv", uri: "db-alpha-connstr" }
  -> secret resolves -> "Server=sql-alpha-1.azure.com;..."
```

**Resolution rules**:

1. Mounts resolve after layer merging, before secret resolution
2. `get(key)`: check if any ancestor key has a mount, rewrite prefix, re-resolve
3. `getNamespace(prefix)`: resolve mount, remap source keys back to mount prefix
4. `inspect(key)`: shows mount metadata and resolved source
5. Cycle detection via visited-set. Max 3 levels of chaining
6. Mount targets can contain other markers (secrets, nested mounts up to depth)

### 4. `x-weaver` Property Extension Namespace

**Breaking change to `ConfigurationPropertySchema`.** All Weaver-specific
extensions move from top-level fields to a namespaced `"x-weaver"` sub-object,
following JSON Schema extension conventions.

```typescript
interface WeaverPropertyExtensions {
  sensitive?: boolean;
  visibility?: ConfigurationVisibility;
  changePolicy?: ConfigChangePolicy;
  reloadBehavior?: ConfigReloadBehavior;
  expressionAllowed?: boolean;
  maxOverrideLayer?: ConfigurationLayer;
  writeRestriction?: ReadonlyArray<ConfigurationRole>;
  sessionMode?: PropertySessionMode;
}

interface ConfigurationPropertySchema {
  // Standard JSON Schema fields (type, properties, required, etc.)
  // ...
  "x-weaver"?: WeaverPropertyExtensions | undefined;
}
```

**Inheritance**: `x-weaver` extensions propagate from parent to child in the
schema tree. Child values override parent values. Resolution walks root to leaf,
merging at each level. This allows setting `visibility: "platform"` at the
namespace root and only overriding on specific properties.

#### Extension Field Reference

**`sensitive`** (boolean): Marks the value as containing secret data. Triggers
secret resolution for `_weaver: "secret-ref"` markers. Sync pipeline must not
transmit plaintext. Policy rule: `sensitive: true` + `visibility: "public"` =
error. Auto-detection heuristic warns on write if key matches
`/password|secret|apiKey|token|credential/i` without explicit `sensitive` flag.

**`visibility`** (ConfigurationVisibility): Controls who can see the property.

| Value | Who Can See | Use Case |
|---|---|---|
| `"public"` | Client-side code, end users | Feature flags, UI labels |
| `"admin"` | Tenant administrators | Tenant settings in admin panels |
| `"platform"` | Platform operators only | Infra endpoints, cluster assignments |
| `"internal"` | Service runtime only | Secrets, inter-service tokens |

Enforced at the serving boundary: weaver-server filters responses based on the
caller's role and the property's visibility.

**`changePolicy`** (ConfigChangePolicy): Controls how changes flow through
the deployment pipeline. Enforced at write time by weaver-server's admin API.

| Value | Meaning |
|---|---|
| `"full-pipeline"` | PR -> review -> staging -> canary -> production |
| `"staging-gate"` | Staging -> production (skips canary) |
| `"direct-allowed"` | Direct writes to any layer (still audited) |
| `"emergency-override"` | Requires active OverrideSession with elevated auth |

weaver-server checks the target layer against the promotion pipeline defined in
`_weaver.server.promotionPipeline`. `full-pipeline` writes to production layers
are rejected; the value must be promoted through the pipeline.

**`reloadBehavior`** (ConfigReloadBehavior): What happens to the running
service when the value changes. Set by the service developer (declarative).

| Value | Meaning |
|---|---|
| `"hot"` | Picked up immediately via onChange listeners |
| `"restart-required"` | Service must restart to pick up the change |
| `"rolling-restart"` | Graceful drain + rolling restart across instances |

For `restart-required` and `rolling-restart`,
`createServiceConfigurationService()` sets `pendingRestart = true` and fires
`onRestartRequired` listeners. The actual restart is an external concern:
the service's health endpoint returns 503, K8s/Rancher liveness probe detects
failure and restarts the pod. For `rolling-restart`, the readiness probe
returns 503 to drain traffic before restart.

**`expressionAllowed`** (boolean): Whether this property's value can be a
config expression (template with variable references). When false (default),
expression-like strings are treated as literals. Prevents accidental injection
in fields where templating would be dangerous.

**`maxOverrideLayer`** (ConfigurationLayer): The highest (most specific)
layer that can set a value. If set to `"tenant"`, site-level and user-level
layers cannot override this value. Prevents lower-level overrides of
platform-controlled settings.

**`writeRestriction`** (ReadonlyArray<ConfigurationRole>): Which roles can
write this property. Works with `LayerWritePolicy` -- even if a user has write
access to the layer, they also need a matching role. Simple role list (OR
semantics). Compound ACL deferred to a future version if needed.

**`sessionMode`** (PropertySessionMode): Behavior during override sessions.

| Value | Meaning |
|---|---|
| `"allowed"` | Can be overridden during an active session |
| `"restricted"` | Requires elevated auth during session |
| `"blocked"` | Cannot be overridden even during a session |

`"blocked"` prevents tampering with critical values (e.g., audit logging
endpoints) even in emergency mode.

### 5. ServiceConfigurationDeclaration (Revised)

The declaration is revised to be enterprise-grade. Key changes:

- `configuration` is now a full `ConfigurationPropertySchema` (type: "object"),
  not a wrapper with just `properties`. Uses standard JSON Schema `required`
  instead of a separate `requiredKeys` field.
- New fields: `schemaVersion`, `owner`, `namespaces`, `instanceConfig`.
- `requiresSecrets` is derived from schema (any property with
  `x-weaver.sensitive: true`), not declared.
- `status` deferred from v1.

```typescript
interface ServiceConfigurationDeclaration {
  /** Unique service identifier -- also the default namespace. */
  serviceId: string;

  /** Human-readable description. */
  description: string;

  /**
   * Monotonically increasing schema version for breaking change detection.
   * Central service diffs old vs new declaration on registration.
   */
  schemaVersion: number;

  /** Owning team or individual. */
  owner: string;

  /**
   * Namespaces this service owns. Defaults to [serviceId] if omitted.
   * For plugin sub-schemas, the plugin uses the parent's serviceId and
   * declares its sub-namespace via the fragments mechanism.
   */
  namespaces?: ReadonlyArray<string> | undefined;

  /**
   * Full ConfigurationPropertySchema (type: "object") describing this
   * service's configuration. Uses standard JSON Schema `required` for
   * mandatory keys, `x-weaver` extensions per property.
   */
  configuration: ConfigurationPropertySchema;

  /**
   * Glob patterns for keys in other namespaces this service reads.
   * `*` = single dot-segment, `**` = multi-segment.
   */
  reads?: ReadonlyArray<string> | undefined;

  /**
   * Schema fragments for plugins/modules with independent lifecycles.
   * Key: dot-path within the configuration tree.
   * Value: fragment schema with independent version and owner.
   */
  fragments?: Record<string, ConfigurationSchemaFragment> | undefined;

  /**
   * When set, this declaration describes a config template that supports
   * multiple named instances with per-instance overrides.
   */
  instanceConfig?: {
    /** How instances are identified. E.g., "widgetId", "pluginId". */
    instanceKey: string;
    /** Max number of instances (for capacity planning). */
    maxInstances?: number;
  } | undefined;
}

interface ConfigurationSchemaFragment {
  /** Human-readable description */
  description: string;
  /** Fragment schema version -- independent of parent schema version */
  schemaVersion: number;
  /** Who owns this fragment */
  owner: string;
  /** Schema for this fragment's config subtree */
  configuration: ConfigurationPropertySchema;
}
```

#### Schema Fragments for Plugin Architectures

Services with plugin/module architectures (e.g., Lynx with 100+ plugins) use
**schema fragments** to avoid namespace pollution. Each plugin registers a
fragment within the parent service's declaration, not a separate top-level
declaration.

```
_weaver.schemas.lynx = {
  serviceId: "lynx",
  configuration: { ... },
  fragments: {
    "plugins.analytics": { description: "...", schemaVersion: 1, ... },
    "plugins.billing": { description: "...", schemaVersion: 2, ... },
  }
}
```

One schema document per service, with fragments nested inside. Plugin
registration is a fragment update, not a full schema re-registration.
Fragments have independent `schemaVersion` and `owner` for separate lifecycles.

Plugin config lives within the parent service's namespace as nested objects:

```
lynx.plugins.analytics.retentionDays = 90
lynx.plugins.billing.currency = "USD"
```

Deep merge handles per-plugin layer overrides naturally.

#### Bracket Notation for Compound Key Identifiers

Plugin IDs may be FQDNs containing dots (e.g., `ghost.settings.panel`).
Bracket notation disambiguates compound identifiers from path separators:

```
lynx.plugins[ghost.settings.panel].retentionDays
```

The `get()` path parser understands brackets:

```typescript
// "lynx.plugins[ghost.settings.panel].retentionDays"
// parses to: ["lynx", "plugins", "ghost.settings.panel", "retentionDays"]
```

In JSON storage, the FQDN is a single property name:

```json
{
  "lynx": {
    "plugins": {
      "ghost.settings.panel": { "retentionDays": 90 }
    }
  }
}
```

Standard JSON -- `plugins["ghost.settings.panel"]` is valid.

### 6. ServiceAccessPolicy

Service access control uses a **two-part model**: the service developer declares
what config the service needs (`ServiceConfigurationDeclaration`), and platform
ops authorizes what the service is allowed to access (`ServiceAccessPolicy`).

**Effective access = declaration intersection policy.**

```typescript
interface ServiceAccessPolicy {
  /** Must match a registered ServiceConfigurationDeclaration.serviceId. */
  serviceId: string;

  /** Namespaces the service is authorized to own (write). */
  allowedNamespaces: ReadonlyArray<string>;

  /** Glob patterns for cross-namespace reads the service is allowed. */
  allowedReads: ReadonlyArray<string>;

  /** Whether the service can receive resolved secret values. */
  allowedSecrets: boolean;

  /** Tenant access scope. */
  tenantScope: "all" | ReadonlyArray<string>;

  /** Identity of the approver. */
  approvedBy: string;

  /** ISO 8601 timestamp of approval. */
  approvedAt: string;

  /** Optional expiration -- forces periodic re-approval. */
  expiresAt?: string | undefined;
}
```

Enforcement flow:

1. Service authenticates (mTLS or OAuth2 client credentials)
2. weaver-server loads `ServiceAccessPolicy` for the service identity
3. weaver-server loads `ServiceConfigurationDeclaration` (registered at startup)
4. Computes effective access: declaration reads intersected with policy allowedReads
5. Returns only authorized config

Policies are stored in the `_weaver.policies.*` namespace (see section 8).

### 7. Service Lifecycle

The end-to-end lifecycle for spinning up a new service:

| Step | Who | What | Where |
|---|---|---|---|
| 1 | Developer | Write config declaration + defaults | Service source code |
| 2 | Developer + reviewer | PR review of declaration | Git |
| 3 | Platform ops | Create `ServiceAccessPolicy` | Central config service admin API |
| 3b | Platform ops | Provision secrets in vault | Azure Key Vault |
| 3c | Platform ops | Set up config values (mounts, secret refs, overrides) | Central config service API per layer |
| 4 | CI/CD | Deploy service with identity only | Kubernetes |
| 5 | Service runtime | Register schema + load config | Central config service API |
| 6 | Platform ops | Ongoing: onboard tenants, rotate secrets, tune config | Central config service API |

The developer never touches secrets or vault configuration. Platform ops never
touches service code. The central config service enforces the intersection of
what the developer declared and what ops authorized.

### 8. `_weaver.*` Reserved Namespace

Schemas, policies, and weaver-server config live under the reserved `_weaver.*`
namespace -- not as dedicated layers. This is consistent with how `_weaver`
markers work for config values.

```
_weaver.schemas.lynx                 -> ServiceConfigurationDeclaration for lynx
_weaver.schemas.vessel-tracking      -> ServiceConfigurationDeclaration for vessel-tracking
_weaver.policies.lynx                -> ServiceAccessPolicy for lynx
_weaver.policies.vessel-tracking     -> ServiceAccessPolicy for vessel-tracking
_weaver.server.vaultEndpoint         -> weaver-server's own config
_weaver.server.adminRoles            -> who can write policies
_weaver.server.promotionPipeline     -> ["staging", "canary", "production"]
```

Namespace ownership:

| Namespace | Owned By | Written By | Read By |
|---|---|---|---|
| `_weaver.*` | weaver-server (reserved) | System | weaver-server |
| `_weaver.schemas.*` | weaver-server | Services at registration | weaver-server |
| `_weaver.policies.*` | weaver-server | Platform ops via admin API | weaver-server |
| `_weaver.server.*` | weaver-server | Platform ops | weaver-server |
| `lynx.*` | lynx service | Ops, service registration | lynx, authorized readers |

No service can own or read from `_weaver.*` unless explicitly authorized.

### 9. Environment Model: Pre-Merge Overlays

Environments (dev, staging, production) use a **pre-merge overlay** pattern.
Each layer has a base + optional per-environment overlays. The overlay is merged
into the base **before** the layer enters the state container.

```
For each layer in environment "staging":
  1. Load base entries from storage (environment = "base")
  2. Load staging overlay from storage (environment = "staging")
  3. Deep-merge: overlay on top of base
  4. Feed merged result to state container via applyLayerData()
```

The state container and resolution engine never see "environment" -- they just
see pre-merged layer data. Environment is a deployment-time concern, not a
request-time dimension.

#### Storage

Config is stored as **nested JSON trees per namespace** (not flattened dot-path
keys). The storage unit depends on the provider:

**Git-backed** (development, GitOps):

```
config/layers/
  platform/
    base/
      db.json               <- { "host": "localhost", "port": 5432 }
      sentinel.json         <- { "publicKeyUrl": "https://..." }
    env.staging/
      db.json               <- { "host": "staging-db.internal" }
    env.production/
      db.json               <- { "host": "prod-db.internal" }
  tenant:acme/
    base/
      lynx.json             <- { "maxUsers": 1000 }
    env.production/
      lynx.json             <- { "maxUsers": 5000 }
```

**Database-backed** (weaver-server in production):

Per-namespace JSON documents or per-key rows indexed by `(layer, environment, key)`.

#### Explicit Environment on All Operations

The environment parameter is always required and explicit. There is no implicit
default. Callers must specify `"base"` for all-environment values.

```typescript
interface ConfigurationStorageProvider {
  load(layer: string, environment: string): Promise<ConfigurationLayerData>;
  save(layer: string, key: string, value: unknown, environment: string): Promise<WriteResult>;
  listEnvironments(layer: string): Promise<string[]>;
}
```

#### Write Concern

Every write specifies layer + environment:

```
PUT /config/db.port   layer=platform  env=base        <- all environments
PUT /config/db.host   layer=platform  env=staging     <- staging only
PUT /config/db.host   layer=platform  env=production  <- production only
```

#### Promotion Between Environments

```
POST /config/promote
  key=feature.newDashboard
  from=staging
  to=production
  layer=platform

weaver-server:
  1. Read value from staging overlay
  2. Check changePolicy -> "staging-gate" -> OK
  3. Write value to production overlay
  4. Create audit entry
```

Git-backed promotion: copy value from `env.staging/` to `env.production/` via PR.

#### Multi-Environment Serving

weaver-server supports both deployment models -- ops decides:

**Separate server per environment** (recommended for production):
One state container, one environment. Security isolation and blast radius containment.

**Single server, multiple environments** (acceptable for dev/test):
One state container per environment. Each layer loaded once per environment.
Base data loaded once from storage, overlay loaded once per environment.

### 10. Provenance and Inspector Metadata

The `inspect()` method is extended to track whether a value came from base
config or an environment overlay.

```typescript
interface ConfigurationInspection<T> {
  key: string;
  effectiveValue: T | undefined;
  effectiveLayer: ConfigurationLayer | string | undefined;
  effectiveSource: ConfigValueSource | undefined;   // NEW
  layerValues: Partial<Record<string, LayerValueDetail<T>>>;
}

interface LayerValueDetail<T> {
  value: T;
  source: ConfigValueSource;
}

interface ConfigValueSource {
  /** "base" or the environment name ("staging", "production") */
  environment: string;
  /** Timestamp of last write to this source */
  lastModified?: string;
}
```

During pre-merge, a source map tracks which keys came from which environment.
The state container stores source maps alongside raw layer data. Inspector UIs
show full provenance: "this value came from the platform layer's staging overlay."

### 11. Materialized Defaults

Schema defaults (JSON Schema `default` field) are **materialized** into a config
layer on registration, keeping the read path simple.

The target layer matches the activation scope:

| Activation Scope | Target Layer | Example |
|---|---|---|
| Platform-level service registration | `defaults` layer (lowest rank) | `vessel-tracking.pollIntervalMs = 5000` |
| Tenant plugin activation | Tenant layer | `lynx.plugins.analytics.retentionDays = 90` in `tenant:acme` |
| Site-specific activation | Site layer | Site-scoped defaults in `site:acme-dover` |

This prevents tenant-installed plugin defaults from polluting the global defaults
layer. Platform ops defaults go to the platform layer. The layer choice matches
who is writing and at what scope.

### 12. Instance Config

Services with multiple instances of the same config template (dashboard widgets,
device fleets, regional deployments) declare instance support at the declaration
level:

```typescript
instanceConfig?: {
  instanceKey: string;     // e.g., "widgetId", "deviceId"
  maxInstances?: number;   // capacity planning
}
```

Resolution is pluggable via `InstanceConfigResolver`:

```typescript
interface InstanceConfigResolver {
  getForInstance<T>(
    namespace: string,
    instanceId: string,
    key: string,
    fallback: () => T | undefined,
  ): T | undefined;
}
```

Two built-in implementations:

- **NamespaceInstanceResolver** (default): Instance overrides stored as
  sub-namespace keys. Best for < 100 instances.
- **StoreInstanceResolver**: Dedicated `InstanceConfigStore` for high
  cardinality (1000+ instances). Separate from main state container.

Consumer chooses at setup time based on their cardinality needs.

### 13. Schema Validation

Validation happens at two checkpoints:

| When | What | Why |
|---|---|---|
| On write | Validate new value against property schema | Catch bad values immediately |
| Post-merge (on load) | Validate merged config against full service schema | Catch layer combination issues |

Post-merge validation catches: layer A sets a field to null, layer B expects
a string. Individually they may pass, but merged result violates `required`.

### 14. Resolution Strategy: Eager at Load Time

All markers (`mount` and `secret-ref`) are resolved during
`createConfigurationService()` startup. The `get()` API remains synchronous.

Resolution pipeline:

```
1. provider.load() for each provider (with environment pre-merge)
2. State container built (raw entries with _weaver markers)
3. Mount resolution pass:
   - Scan for { _weaver: "mount" } entries
   - Build mount prefix map: mountKey -> sourcePrefix
4. Secret resolution pass:
   - Scan all entries (following mounts) for { _weaver: "secret-ref" }
   - Resolve via SecretProvider -> plaintext
   - Store in secret cache (shadow map)
5. Service ready. get() is synchronous.
6. Background refresh: re-resolve secrets on TTL expiry
   - If value changed (rotation), fire onChange listeners
```

### 15. Package Structure

#### Types in `@weaver-conf/config-types`

New/modified files:

- `markers.ts` -- `WeaverMarker` union, `SecretReference`, `ConfigMount`,
  `isWeaverMarker()`, `isSecretReference()`, `isConfigMount()`
- `schemas-markers.ts` -- Zod schemas for all marker types
- `property-schema.ts` -- **Breaking change**: `x-weaver` namespace for
  extensions, `WeaverPropertyExtensions` type
- `access.ts` -- Revised `ServiceConfigurationDeclaration`,
  `ConfigurationSchemaFragment`, `ServiceAccessPolicy`
- `environment.ts` -- `ConfigValueSource`, `MergedLayerResult`
- `instance.ts` -- `InstanceConfigResolver` interface

#### Resolution Engine: `@weaver-conf/config-secrets` (new package)

Server-side package:

- `SecretResolutionService` -- `resolveAll()`, `resolve()`, `store()`,
  `rotate()`, `delete()`, `invalidate()`, `shutdown()`
- `SecretCache` -- TTL-based cache with background refresh
- `SecretAuditLog` -- Adapter interface for audit trail
- `AzureKeyVaultProvider` -- First `SecretProvider` implementation

Dependencies: `@weaver-conf/config-types` only.

Azure SDK (`@azure/keyvault-secrets`, `@azure/identity`) is a direct dependency,
planned for extraction to `@weaver-conf/config-secrets-azure` later.

#### Integration: `@weaver-conf/config-providers`

`createConfigurationService()` gains optional `secrets` and mount resolution:

1. Load providers -> state container (raw entries with markers)
2. Build mount resolution map (scan for `_weaver: "mount"`)
3. Resolve secrets (scan for `_weaver: "secret-ref"`, resolve via vault)
4. `get()` checks: mount map -> secret cache -> state container
5. Bracket notation parsing in path traversal

#### Policy: `@weaver-conf/config-policy`

New rule: `sensitive: true` + `visibility: "public"` = error.

#### Dependency Graph

```
config-types (leaf -- markers, x-weaver, declarations, policies)
    |
    +-- config-engine (schema registry, bracket-aware path parsing)
    |       |
    |       +-- config-providers --optional-dep--> config-secrets
    |       |   (mount resolution + secret resolution    |
    |       |    orchestration + env pre-merge)           |
    |       +-- config-server                      config-types
    |       +-- config-policy (new rule)
    |
    +-- config-secrets (secret resolution + Azure provider)
    |       depends only on config-types
    |
    +-- config-auth
    +-- config-sync
    +-- config-sessions
```

### 16. Recommended Deployment: Fully Central

```
+-----------------------------------------------+
|  Central Configuration Service (weaver-server) |
|  -------------------------------------------   |
|  - Loads all layers from providers             |
|  - Pre-merges environment overlays             |
|  - Holds all vault credentials                 |
|  - Resolves ALL secrets                        |
|  - Resolves ALL mounts                         |
|  - Validates declarations against policies     |
|  - Filters by service namespace + declaration  |
|  - Tracks provenance (layer + env source)      |
|  - Serves resolved config via API (mTLS)       |
+-------------------+---------------------------+
                    | mTLS / service mesh
          +---------+---------+
          v         v         v
      Accounts   Lynx     Shipping
      (config    (config   (config
       client)    client)   client)
```

The central service is the only component that runs `config-secrets`. Backend
services receive resolved plaintext via a protected API. This avoids the
bootstrap problem (services don't need vault configuration) and centralizes
credential management.

The library also supports hybrid (central config + local secret resolution)
and fully local deployment models. The architecture is topology-agnostic.

weaver-server will be built in a later phase. Types and schemas are defined in
`config-types` now; enforcement and storage logic will live in the
`@weaver-conf/weaver-server` package.

### 17. Security Properties

| Concern | Mitigation |
|---|---|
| Plaintext in memory | Secret cache only, never state container/logs/sync |
| Plaintext in transit | mTLS between central service and backend services |
| Vault credential | Central service uses managed identity |
| Audit trail | Every operation produces `SecretAuditEntry` |
| Policy enforcement | `full-pipeline` for sensitive keys; `sensitive + public = error` |
| Access control | Declaration intersection policy = effective access |
| Reference validation | Zod schema validates marker shapes at boundaries |
| Rotation | Background refresh detects version changes |
| Mount cycles | Visited-set detection, max depth 3 |
| Environment isolation | Separate weaver-server per env (recommended for prod) |

### 18. Tenant Isolation

Both models supported at the `AzureKeyVaultProvider` options level:

- **Vault-per-tenant**: Separate provider instance per tenant with distinct
  `vaultUrl`. Maximum isolation.
- **Prefix-per-tenant**: Single vault, secrets namespaced by `secretPrefix`.
  Simpler operations.

### 19. Auto-Store on Write

When `configService.set()` targets a key with `x-weaver.sensitive === true`:

1. `config-providers` checks schema registry for sensitivity
2. Calls `secretService.store()` -> vault stores secret
3. `SecretReference` written to config layer (not plaintext)
4. Plaintext cached in secret cache

Transparent to consumers.

## Future Considerations

The following work items were designed during this ADR but deferred from the v1
implementation. They are organized by phase to guide sequencing.

### Phase 2: weaver-server — Central Enforcement

The central configuration server is the primary enforcement point for most of
the access control and lifecycle features designed in this ADR.

**weaver-server package** (`@weaver-conf/weaver-server`): The central configuration
server application. Stores all config data (including policies), enforces
`ServiceAccessPolicy` at request time, registers and validates
`ServiceConfigurationDeclaration` at service startup, resolves secrets before
serving to clients, and exposes an admin API for platform ops. Uses Weaver to
manage its own data (`_weaver.*` namespace). This is the highest-priority
future work item — most other deferred features depend on it.

**ServiceAccessPolicy enforcement**: Runtime enforcement of declaration ∩ policy
= effective access. Requires weaver-server to intercept config reads, load both
the declaration and the policy for the authenticated service identity, compute
the intersection, and filter the response. Designed in sections 6–7.

**`changePolicy` enforcement**: Write-time enforcement of the promotion pipeline.
weaver-server checks the target layer against `_weaver.server.promotionPipeline`
and rejects writes that skip required stages (e.g., `full-pipeline` writes
directly to production). Designed in section 4 (`changePolicy` extension).

**`maxOverrideLayer` enforcement**: Write-time check that prevents lower-level
layers (site, user) from overriding values restricted to higher layers.
Designed in section 4 (`maxOverrideLayer` extension).

**`writeRestriction` enforcement**: Role-based write gating per property,
layered on top of `LayerWritePolicy`. Even if a user has layer write access,
they need a matching role from the property's `writeRestriction` list.
Designed in section 4 (`writeRestriction` extension).

**Schema registration and diffing**: Runtime registration of
`ServiceConfigurationDeclaration` with breaking-change detection. Central service
diffs old vs new `schemaVersion`, flags removals or type changes, and optionally
blocks registration until acknowledged. Designed in section 5.

**Config promotion pipeline**: `POST /config/promote` API for moving values
between environments with `changePolicy` enforcement and audit trail.
Designed in section 9.

**Admin API for policies**: CRUD operations for `ServiceAccessPolicy` objects,
restricted to roles listed in `_weaver.server.adminRoles`. Designed in section 8.

**HttpStorageProvider**: A `ConfigurationStorageProvider` implementation that
fetches config from weaver-server via HTTP/mTLS. Enables backend services to
use the config client library to load config from the central server instead of
direct storage access.

### Phase 3: Advanced Resolution

**Expression marker** (`_weaver: "expression"`): A third marker type for dynamic
value computation. Would enable computed config values using a safe expression
language with built-in functions (`config()`, `env()`) and context variables
(`tenant.id`, `scope.*`). Designed in section 1. Requires:
- Expression language design (safe subset, no side effects)
- Sandboxed evaluation engine
- Cycle detection for expression → config → expression chains
- Security review for injection risks
- `expressionAllowed` extension field enforcement

**Schema validation at write-time and post-merge**: Two validation checkpoints
designed in section 13. Write-time validation catches bad values immediately;
post-merge validation catches layer combination issues (e.g., one layer sets a
field to null, another expects a string). Requires schema registry integration
in the write path and a post-merge validation pass in the state container.

**Materialized defaults**: Automatic materialization of JSON Schema `default`
values into appropriate config layers on registration. Target layer matches
activation scope: platform defaults → defaults layer, tenant plugin activation →
tenant layer, site-specific → site layer. Designed in section 11. Requires
schema registry + layer write access during registration.

**`reads` glob pattern enforcement**: Runtime enforcement of the `reads` field
on `ServiceConfigurationDeclaration`. When a service requests a cross-namespace
key, weaver-server checks whether the key matches any glob pattern in the
service's declared `reads` AND the policy's `allowedReads`. `*` matches a single
dot-segment, `**` matches multiple segments. Designed in section 5.

### Phase 4: Instance Config and Scale

**InstanceConfigResolver implementations**: Two built-in resolvers designed in
section 12 but not implemented:

- **NamespaceInstanceResolver** (default): Instance overrides stored as
  sub-namespace keys (e.g., `dashboard.widgets.<widgetId>.color`). Simple,
  best for < 100 instances per template.
- **StoreInstanceResolver**: Dedicated `InstanceConfigStore` with separate
  storage optimized for high cardinality (1000+ instances). Separate from the
  main state container to avoid key explosion.

Consumer chooses at setup time via `createServiceConfigurationService()` options
based on their cardinality needs.

**`reloadBehavior` integration**: While the `reloadBehavior` extension field
is defined (section 4), the integration with container orchestration is not
built. Requires:
- `createServiceConfigurationService()` sets `pendingRestart = true` on
  `restart-required` or `rolling-restart` changes
- `onRestartRequired` listener fires for consuming service
- Health endpoint returns 503 for K8s/Rancher liveness probe detection
- Readiness probe returns 503 for traffic drain before rolling restart

### Phase 5: Provider Ecosystem and Operations

**Extract Azure provider**: Move `AzureKeyVaultProvider` from `config-secrets`
to a dedicated `@weaver-conf/config-secrets-azure` package. Keeps the core
`config-secrets` package free of cloud-specific dependencies. The current direct
dependency on `@azure/keyvault-secrets` and `@azure/identity` is intentionally
temporary.

**Additional secret providers**: The `SecretProvider` interface is designed
for multi-provider support. Future implementations:
- `@weaver-conf/config-secrets-aws` — AWS Secrets Manager
- `@weaver-conf/config-secrets-gcp` — Google Cloud Secret Manager
- `@weaver-conf/config-secrets-hashicorp` — HashiCorp Vault
- `@weaver-conf/config-secrets-local` — File-based provider for local development

**Secret resolution proxy**: A hardened, network-isolated microservice dedicated
to secret resolution. The central config service delegates vault access to this
proxy for defense-in-depth isolation. Vault credentials never leave the proxy's
network segment.

**Rotation webhook handler**: Azure Event Grid (or equivalent) webhook handler
for automatic `SecretCache` invalidation on secret rotation events. Eliminates
TTL-based polling latency for rotation detection.

**`sessionMode` enforcement**: Runtime enforcement of the `sessionMode` extension
during `OverrideSession` operations. `"blocked"` prevents modification even in
emergency mode (critical for audit logging endpoints, security config).
`"restricted"` requires elevated auth. Designed in section 4.

### Phase 6: Developer Experience

**Schema-driven admin UI**: Auto-generate admin configuration panels from
`ServiceConfigurationDeclaration` schemas. `x-weaver` extensions drive UI
behavior: `visibility` controls field visibility, `changePolicy` shows
promotion requirements, `sensitive` masks values, `reloadBehavior` shows
restart warnings.

**Config diff and audit viewer**: Visual diff tool showing config changes
across environments and layers with full provenance (which layer, which
environment overlay, who wrote it, when). Built on `ConfigurationInspection`
and `ConfigValueSource`.

**Declaration linter**: Static analysis tool that validates
`ServiceConfigurationDeclaration` files before deployment. Checks for: missing
`x-weaver` on sensitive-looking keys, overly broad `reads` patterns, schema
version consistency, fragment compatibility.

### Sequencing Dependencies

```
Phase 2 (weaver-server)
  ├── Phase 3 (advanced resolution) — needs schema registry from Phase 2
  ├── Phase 4 (instance config) — needs registration API from Phase 2
  └── Phase 5 (provider ecosystem) — can partially overlap with Phase 2
        └── Phase 6 (developer experience) — needs Phase 2 + 5 foundations
```

Phase 5 (provider extraction, additional providers) can begin independently
once the `SecretProvider` interface is stable. Phase 6 depends on Phase 2's
admin API and Phase 5's multi-provider support.

## Consequences

- New `_weaver` marker system in `@weaver-conf/config-types` (SecretReference +
  ConfigMount types, Zod schemas, type guards)
- **Breaking change**: `ConfigurationPropertySchema` extensions move to
  `x-weaver` namespace. All existing code using `schema.sensitive`,
  `schema.visibility`, etc. must update to `schema["x-weaver"]?.sensitive`.
- **Breaking change**: `ServiceConfigurationDeclaration` gains required fields
  (`schemaVersion`, `owner`) and `configuration` becomes full
  `ConfigurationPropertySchema` instead of wrapper.
- **Breaking change**: `ConfigurationStorageProvider` gains `environment`
  parameter on `load()` and `save()`.
- New `ServiceAccessPolicy` type in `@weaver-conf/config-types`
- New `ConfigurationSchemaFragment` type for plugin architectures
- New `ConfigValueSource` and extended `ConfigurationInspection` for provenance
- New `@weaver-conf/config-secrets` package (server-side only)
- `@weaver-conf/config-providers` gains marker resolution (mounts + secrets),
  bracket-aware path parsing, and environment pre-merge
- `@weaver-conf/config-policy` gains sensitive + public visibility rule
- `@weaver-conf/config-engine` gains bracket-aware path parsing
- No changes to `config-sync`, `config-auth`, `config-sessions`
- Azure SDK as direct dependency (future extraction planned)
- `_weaver.*` namespace reserved for schemas, policies, server config
