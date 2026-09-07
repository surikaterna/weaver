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
- `SchemaRegistry` — Path-first schema registration and validation
- `ScopeManager` — Scope provisioning and hierarchy management
- `SessionManager` — Override session lifecycle (create, expire, audit)
- `PromotionEngine` — Promotes values between layers with approval workflows
- `RollbackService` — Reverts configuration to previous revisions

Registered schemas are enforced at the effective runtime read boundary. Public
`resolveAll`, `get`, and `getNamespace` calls validate values after layer and
scope merging plus mount and secret resolution. Reads that contain, target, or
descend from an invalid registered anchor fail with `VALIDATION_ERROR`; REST
maps this runtime condition to HTTP 422. Unrelated unregistered reads and
schema-compatible partial layer writes remain available, but an incomplete
effective value is not served until later layers or writes complete it.
Subscription feeds apply the same boundary to base and materialized scope
contexts. Overlapping registrations are emitted as one aggregate root: an
invalid member removes that root, while recovery emits one fully resolved root
value. Successful schema registration triggers the same projection after the
registry is applied (and persisted when persistence is configured).

### Auth

- `createAuthMiddleware(options)` — JWT-based request authentication
- `createJwtValidator(options)` — Token validation and identity extraction

### Audit

- `createAuditService(options)` — Pluggable audit logging with multiple sinks
- `createFileSystemAuditLog()` — File-based audit sink
- `createMongoAuditSink(options)` — MongoDB audit sink
- `createStdoutAuditSink()` — Console audit sink for development

## License

MIT
