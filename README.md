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
