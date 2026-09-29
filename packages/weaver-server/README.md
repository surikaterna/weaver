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

The legacy identity list is O(registered anchors + declared slots), still unpaged, and transfers no schema bodies; exact detail is O(the selected schema). For bounded-count browsing, use admin `GET /v1/admin/schemas/identities/pages?limit=50&cursor=...` or trusted SCOMP `listRegisteredSchemaIdentityPage({limit?,cursor?})`. The response is `{anchors,slots,nextCursor,hasMore}`; follow `nextCursor` until null. Default limit is 50, maximum 200. Set `WEAVER_SCHEMA_IDENTITY_MAX_PAGE_SIZE` or `WeaverServerOptions.schemaIdentityMaxPageSize` to a canonical integer from 50 through `Number.MAX_SAFE_INTEGER` to lower or raise the maximum; the option wins, but a supplied invalid environment value still prevents startup. Requests above the effective maximum fail, not clamp. Raising the maximum above 200 increases per-response memory/serialization risk.

The private sorted index retains O(N) identity references, builds on hydration and rebuilds on successful registration in O(N log N) time with O(N) temporary memory; each page is O(limit) time/output memory without schema projections outside the page. Ordering is JS code-unit environment, path, kind. Cursor is a fixed 55-character canonical base64url ordinal (version, random process instance, local revision, effective limit, next offset), **not** a credential or signed integrity proof: a syntactically valid forged nonce can produce 409, and a forged valid offset can select a different page. Local successful registrations, even no-ops, invalidate previous cursors; failed writes do not. Restart invalidates cursors. A hydrated registry does not detect changes made by another process in protected storage: there is **no cross-process snapshot or cross-writer 409 guarantee**. Count is not a byte cap: registration count, path/environment lengths, and serialized response bytes remain unbounded, and legacy bulk/list remain unpaged. A small fixture's byte comparison is not a DoS bound. Operate a controlled registry, restrict admin/SCOMP access, and apply deployment ingress rate and response controls where available; these are operational mitigations, **not** server-enforced memory or response guarantees. Exact detail checks both path and environment after lookup; legacy bulk remains colon-keyed for unambiguous entries and fails with `SCHEMA_CONFLICT` on distinct identities sharing a legacy key (no partial result). Use identity listing and exact detail to inspect such registries.

### Schema registry v2 upgrade and rollback (`weaver-afwt`)

Before deploying, stop **all old registration writers**; mixed old/new writers are unsupported. Take a verified, restorable snapshot of the protected `_weaver.registry.schemas` root (including its enclosing storage layer) and retain the authoritative service/fragment registration source. A versionless grouped v1 root loads read-only. The first successful registration writes the complete strict `{version:2,environments:{...}}` snapshot through the existing internal write path; unsuccessful registration or persistence failure does not upgrade the root. The schema graph codec inside entries remains version 1. Old binaries **cannot read v2**: never restart one against upgraded storage. To roll back, stop all new writers, restore the verified pre-upgrade v1 snapshot, then start old binaries. This discards registrations made since that snapshot. Prefer a forward v2 fix/redeploy if those registrations must be retained. Compare identities with the authoritative source/backup and re-register any missing identities from that source; a lone valid colon-bearing legacy entry cannot reveal whether an alias was lost, so never infer or fabricate its counterpart. An invalid envelope, metadata mismatch, or malformed graph fails registry startup before writes: investigate/restore from the snapshot rather than editing keys in place.

### Audit

- `createAuditService(options)` — Pluggable audit logging with multiple sinks
- `createFileSystemAuditLog()` — File-based audit sink
- `createMongoAuditSink(options)` — MongoDB audit sink
- `createStdoutAuditSink()` — Console audit sink for development

## License

MIT
