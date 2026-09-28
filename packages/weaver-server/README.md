# @weaver-conf/weaver-server

> Central configuration server for Weaver — layer resolution, auth, audit, schema registry, and storage orchestration.

## Installation

```bash
pnpm add @weaver-conf/weaver-server
```

## Usage

```typescript
import { bootstrap } from "@weaver-conf/weaver-server";

const server = await bootstrap({
  layers: ["core", "app", "tenant", "user"],
  storage: { type: "filesystem", basePath: "./config" },
  auth: { jwtSecret: process.env.JWT_SECRET },
});
```

## API

### Bootstrap

- `bootstrap(options)` — Initializes the server with storage, auth, and layer configuration
- `createProviders(options)` — Creates storage provider instances from configuration

### Core Services

- `WeaverConfigService` — Central service for reads, writes, and resolution
- `SchemaRegistry` — Namespace schema registration and validation
- `ScopeManager` — Scope provisioning and hierarchy management
- `SessionManager` — Override session lifecycle (create, expire, audit)
- `PromotionEngine` — Promotes values between layers with approval workflows
- `RollbackService` — Reverts configuration to previous revisions

### Auth

- `createAuthMiddleware(options)` — JWT-based request authentication
- `createJwtValidator(options)` — Token validation and identity extraction

### Registered schema browsing (operator access)

`GET /v1/admin/schemas/identities` returns only service/fragment path, kind, and environment plus declared slots' path, environment, and `accepts`. It includes empty slots, not schemas or owner metadata. `GET /v1/admin/schemas/anchors/*anchorPath?env=<environment>` returns the schema and registration metadata for **one exact** anchor and environment; children, slots, and unknown environments do not resolve by prefix. Both HTTP routes require an authenticated admin with read access to `_weaver.registry.schemas`. Trusted SCOMP peers expose the same operations and data, but do **not** perform per-user HTTP authorization: do not expose a trusted peer to an untrusted browser or Pages origin. The legacy admin bulk schema route remains for compatibility and explicitly opted-in client boot validation.

The identity list is O(registered anchors + declared slots) and transfers no schema bodies; exact detail is O(the selected schema). Neither operation has a response cap or pagination: registration count, identity path/environment lengths, and serialized response size are **unbounded**. A small fixture's byte comparison is not a DoS bound. Operate a controlled registry, restrict admin/SCOMP access, and apply deployment ingress rate and response controls where available; these are operational mitigations, **not** server-enforced memory or response guarantees. Formal large-registry limits/pagination belong to `weaver-ge6l`. The exact detail read checks both path and environment after registry key lookup to prevent cross-identity disclosure; it cannot restore entries lost to legacy colon-delimited write-key collisions (`weaver-afwt`).

### Audit

- `createAuditService(options)` — Pluggable audit logging with multiple sinks
- `createFileSystemAuditLog()` — File-based audit sink
- `createMongoAuditSink(options)` — MongoDB audit sink
- `createStdoutAuditSink()` — Console audit sink for development

## License

MIT
