# 🧶 Weaver

> Layered configuration management for TypeScript — nested JSON, compile-time typed views, and hierarchical scopes.

## Features

- **Typed client views** — generic namespace and instance access without a second runtime schema
- **Nested JSON storage model** — canonical nested objects resolved with bracket-aware storage keys
- **Hierarchical scopes** — region → tenant → user resolution via scope stacks
- **Schema governance** — JSON Schema validation, ceiling enforcement, and change policies
- **Offline-first sync** — conflict resolution with LWW fallback and queue management
- **Multiple transports** — HTTP/SSE or SCOMP (multiplexed RPC)
- **Layered storage backends** — file system, Git, MongoDB, in-memory, env-overlay
- **Secret management** — provider abstraction with caching (for example, Azure Key Vault)

## Quick Start

Register the service's JSON Schema before schema-enabled consumers start:

```typescript
import type {
  ConfigurationPropertySchema,
  SchemaRegistrationRequest,
} from "@weaver-conf/config-types";
import {
  createHttpTransport,
  createWeaverClient,
} from "@weaver-conf/weaver-client";

const schema = {
  type: "object",
  required: ["theme"],
  properties: {
    theme: { type: "string", enum: ["light", "dark"] },
    sidebarOpen: { type: "boolean" },
  },
  additionalProperties: false,
} satisfies ConfigurationPropertySchema;

const request: SchemaRegistrationRequest = {
  serviceId: "my-service",
  environment: "default",
  owner: { name: "My Service", contact: "team@example.com" },
  schema,
  fragmentSlots: [],
};

const registrationClient = await createWeaverClient({
  transport: createHttpTransport({ baseUrl: "http://localhost:3399" }),
});
await registrationClient.registerSchema(request);
await registrationClient.close();

interface MyConfig {
  theme: "light" | "dark";
  sidebarOpen: boolean;
}

const client = await createWeaverClient({
  transport: createHttpTransport({ baseUrl: "http://localhost:3399" }),
  schemas: true,
});
const config = client.namespace<MyConfig>("my-service");
const theme = config.get("theme"); // "light" | "dark" | undefined
await config.set("theme", "dark");
```

`ConfigurationPropertySchema` is Weaver's sole runtime schema model. Generic client types are erased compile-time assertions: they do not validate or parse values, and server validation remains authoritative. Write the interfaces by hand or generate them with external tooling; Weaver ships no type generator or Zod adapter for this flow.

Registration uses canonical slash anchors. The request above owns `/my-service`; a fragment can own an anchor such as `/my-service/plugins/analytics`. Client reads and writes instead use dotted or bracket-aware storage keys such as `my-service.theme` and `my-service[feature.flag]`. Slash anchors are not accepted as client storage-key aliases.

`schemas: true` loads the `default` schema environment at boot for client preflight validation and metadata. Use `schemas: { environment: "production" }` to select the `production` schema environment. `SchemaOptions.live` does not automatically subscribe to schema changes: restart the client to load newly registered schemas. If migrating from Zod-based namespace definitions, register JSON Schema directly and keep the TypeScript interface separate; no automatic conversion or schema-to-type inference runs in the client.

## Architecture

### Opt-in programmatic server authority

`startWeaverServer({ authority, ... })` hosts the same `config-service` authority
used by embedded hosts. Omitting `authority` retains the legacy server; this is not
a default cutover or a CLI/config-file serialization feature. The one-argument
`createConfigurationService(configuration)` remains read-only; governed writes
require explicit trusted host composition.

The following example assumes the provider already contains canonical persisted
registry metadata at `_weaver.registry.schemas`, produced by Weaver's existing
registry persistence helpers. Provision that metadata **before** starting this
server, with no concurrent writer. Missing or invalid metadata rejects startup;
startup never creates, migrates, or re-registers schemas. `configuration.schemas`
must be empty because the exact persisted canonical reader is injected into the
shared root.

```typescript
import { createFileSystemStorageProvider } from "@weaver-conf/storage-providers";
import {
  canonicalConfigurationPathSchema, createWeaverError, defineWeaver, Layers,
} from "@weaver-conf/config-types";
import { startWeaverServer, type ServerAuthorityOptions } from "@weaver-conf/weaver-server";

const jwtSecret = process.env.WEAVER_JWT_SECRET;
if (!jwtSecret) throw new Error("Configure the JWT verification secret first");
const provider = createFileSystemStorageProvider({
  id: "disk", layer: "files", filePath: "./configuration.json", writable: true,
});
const identity = { environment: "production", scopePath: [] };
const namespace = canonicalConfigurationPathSchema.parse("/my-service");
const authority: ServerAuthorityOptions = {
  configuration: {
    identity, schemas: [],
    layers: [{ kind: "fixed", layer: "files", providerIds: ["disk"] }],
    providers: [{
      id: "disk", layer: "files", provider,
      environment: { kind: "environments", environments: ["production"] },
      operation: { kind: "load-layer", layer: "production-document" },
      ownership: { kind: "owned", dispose: () => provider.dispose() },
    }],
  },
  registry: { providerId: "disk", layer: "files" }, // Logical layer, not storage dialect.
  authConfig: {
    weaverConfig: defineWeaver([Layers.Static("files")]),
    visibilityRoles: { admin: new Set(), platform: new Set() },
    layerWritePolicies: [{ layer: "files", allowedRoles: ["editor"] }],
    dynamicScopeRoles: new Set(),
  },
  hostAuthority: {
    authorizeReadSync: () => "allowed",
    authorizeWrite: async () => "allowed",
  },
  writers: [{
    providerId: "disk",
    operation: { kind: "write-layer", layer: "production-document" },
    flush: "none", failureSemantics: "unknown",
  }],
  mapPrincipal(verified) {
    if (verified.identity.userId !== "configuration-editor")
      throw createWeaverError("FORBIDDEN", "Unmapped identity");
    return {
      principalId: verified.identity.userId, roles: ["editor"],
      grants: [{ identity, namespace, operations: ["read", "inspect", "write"],
        layers: ["files"], views: [], sensitive: false }],
    };
  },
};
const server = await startWeaverServer({ authority, jwtSecret, port: 3399 });
// On host shutdown: await server.close();
```

The mapper is a synchronous trusted host policy receiving a **verified** JWT
context, not an authentication bypass. Production hosts should map their actual
issuer identities and policy explicitly; URL/body values never grant roles or
authority. Even service/admin JWT flags confer no implicit grant. Supplied JWT
expiry caps the mapped principal expiry. Every operation uses a separate minted
capability, prepares its exact identity, and revokes it in `finally`; it never
rebinds the root. Preparation requires one complete `read` grant covering **all
configured logical layers**, including for writes. There are no hidden layer ranks
or default platform/tenant/session policies. `writers: []` explicitly disables
writes.

This mode exposes a narrow, authenticated raw HTTP subset:

| Request | Contract |
| --- | --- |
| `GET /v1/config/my-service/theme` | `data: { key, value? }`; a declared missing leaf omits `value` |
| `GET /v1/config/my-service/theme?inspect` | Canonical hydrated inspection: identity, revision, effective value and contributions |
| `PUT /v1/config/my-service/theme?layer=files` | JSON body exactly `{ "value": "dark" }` |
| `DELETE /v1/config/my-service/theme?layer=files` | No body or empty JSON object; recomputes lower-layer fallback |

Paths use canonical slash-separated literal segments; a literal dot is **not** a
separator. URI-encode each segment once, with no Unicode normalization. Bracket
segments, aggregates, arrays, views and sensitive handles are not part of this
public primitive/null leaf slice. `env` must equal the configured environment.
Omitted `scope` selects the initial identity; `scope=` selects no scopes; nonempty
selectors use the existing comma-separated `scopeId:value,scopeId:value` HTTP
encoding. Duplicate scope IDs, extra colons, unknown query keys, and per-call
actor/role/session fields reject instead of widening the request.

Writes require an explicit logical `layer`; one quoted or unquoted `If-Match`
token becomes `ifRevision`. Lists, weak tags, wildcard and malformed tags reject.
Successful writes return HTTP 200 with `data: { success: true, layer, revision }`;
that **returned result revision** supplies both `meta.revision` and ETag. Rejected
or uncertain writes retain the canonical `data: { success: false, outcome, error }`
and repeat the sanitized error at top level, with `meta.revision: ""` and **no
ETag**. Policy/schema errors are 400, denied access 403, stale revisions 409,
unavailable/fenced writes 503, and unknown write outcome 500. An unknown outcome
is not proof of rollback: the root fences further writes and reports degraded
readiness. It does not retry or replay mutations. Recreating a resolved host root
invalidates old `If-Match` tokens even when values are unchanged.

SSE, list/batch configuration, registered-schema mutation, administrative, scope,
session and SCOMP endpoints are unavailable in this mode (recognized unsupported
REST routes return 501; unknown routes return 404). **The current SDK's list/SSE
startup and legacy inspect contract are not compatible with this subset.** Full
SDK integration belongs to `weaver-0b81.9`, not this opt-in mode. Anonymous health
and CORS preflight disclose no configuration or principal data. Shared malformed
JSON parsing remains a bare 400 response; malformed REST targets retain the
existing outer error envelope.

The server owns transferred provider-disposal hooks, lending borrowed bindings to
the core. Borrowed host providers remain host-owned. Memoized `close()` fences new
work, stops the listener, waits for actual in-flight core IO/required flush to
settle, then attempts every owned hook once. A slow provider can therefore delay
close; the legacy shutdown timeout is not used as a false completion barrier.
Disconnect after dispatch does not cancel, roll back, or replay the write.
Required flush is provider-specific completion, not universal durability; dispose
is never treated as flush. There must be **one authoritative API writer per backing
domain**, enforced by deployment, not a distributed lease in Weaver. Keep schema
metadata stable for the root lifetime. Live registry administration, external
refresh, streaming, sessions and broader mutation/SDK compatibility are separate
increments, not guarantees of this first vertical slice.

Weaver resolves configuration by merging layers bottom-to-top across hierarchical scopes:

```
  session  ← Ephemeral  (override sessions, auto-expiry)
  user     ← Personal   (user preferences)
  tenant   ← Dynamic    (org-specific overrides)
  app      ← Static     (application defaults)
  core     ← Static     (platform defaults)
  ───────────────────────────────────────────────
  Higher layers override lower ones.
  Deep merge: objects recurse, arrays replace, null clears.
```

Configuration is stored as nested JSON objects. The resolution engine composes values across layers and scopes, while clients address members through storage keys.

## Packages

| Package | Description |
| --- | --- |
| [`@weaver-conf/config-types`](./packages/config-types) | Core types, runtime contracts, and schema registration types |
| [`@weaver-conf/config-engine`](./packages/config-engine) | Resolution engine, validation, and deep object operations |
| [`@weaver-conf/config-runtime`](./packages/config-runtime) | Pure state container and snapshot management |
| [`@weaver-conf/config-sync`](./packages/config-sync) | Offline-first sync orchestrator with conflict resolution |
| [`@weaver-conf/config-secrets`](./packages/config-secrets) | Secret provider abstraction and caching |
| [`@weaver-conf/config-policy`](./packages/config-policy) | Change policy evaluation and one-way ratchet rules |
| [`@weaver-conf/config-sessions`](./packages/config-sessions) | Time-limited override sessions |
| [`@weaver-conf/storage-providers`](./packages/storage-providers) | File, Git, MongoDB, memory, and environment-overlay storage |
| [`@weaver-conf/weaver-client`](./packages/weaver-client) | Unified client SDK with generic views, validation, and offline boot |
| [`@weaver-conf/weaver-server`](./packages/weaver-server) | REST/SSE and SCOMP server with the authoritative schema registry |

## Guides

- [Browser Client](./docs/guides/browser-client.md)
- [Backend Client](./docs/guides/backend-client.md)
- [Server Quickstart](./docs/guides/server-quickstart.md)
- [Bootstrap Config Repository](./docs/guides/bootstrap-config-repo.md)

## Development

```bash
pnpm install
pnpm run build
pnpm run test
```

## License

MIT
