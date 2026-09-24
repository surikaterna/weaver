# Browser Client Guide

Use `@weaver-conf/weaver-client` in a browser application for compile-time typed, real-time configuration with offline support.

## Installation

```bash
pnpm add @weaver-conf/weaver-client
```

## Create the Client

The owning service should register its `ConfigurationPropertySchema` before browser clients start. It is Weaver's sole runtime schema model. Enable schema loading when creating the browser client:

```typescript
import {
  createHttpTransport,
  createIndexedDbPersistence,
  createWeaverClient,
} from "@weaver-conf/weaver-client";

const client = await createWeaverClient({
  transport: createHttpTransport({ baseUrl: "/api/config" }),
  persistence: createIndexedDbPersistence({ dbName: "my-app-config" }),
  schemas: true,
});
```

`schemas: true` loads schemas registered in the `default` environment. To use another schema environment, select it explicitly:

```typescript
const productionClient = await createWeaverClient({
  transport: createHttpTransport({ baseUrl: "/api/config" }),
  schemas: { environment: "production" },
});
```

Schema environment selection controls client validation and metadata. Runtime validation by the server remains authoritative.

## Access Typed Configuration

Provide a handwritten interface or one created by external tooling, then select a storage prefix:

```typescript
interface MyConfig {
  mode: "light" | "dark";
  accent: string;
  betaEnabled: boolean;
}

const config = client.namespace<MyConfig>("my-service");
const mode = config.get("mode"); // "light" | "dark" | undefined
await config.set("mode", "dark");
const current = config.getAll(); // Partial<MyConfig>
```

The generic is an erased compile-time assertion. It constrains calls but does not parse values or prove that local state matches `MyConfig`. Weaver ships no type generator or Zod adapter; server validation and the registered JSON Schema are the runtime authority.

## Storage Keys and Registration Anchors

Schema registration derives canonical slash anchors such as `/my-service` and `/my-service/plugins/analytics`. Client APIs do not accept those anchors as aliases. They use dotted or bracket-aware storage keys:

```typescript
client.get<boolean>("my-service.betaEnabled");
client.get<boolean>("my-service[feature.flag]"); // literal-dot member
client.get<number>("my-service.plugins.analytics.sampleRate");
```

Use slash paths for registration and storage keys for client access; do not interchange the formats.

## Scoped and Instance Access

```typescript
const tenantConfig = config.withScope([
  { scopeId: "tenant", value: "acme" },
]);
const tenantMode = tenantConfig.get("mode");

const panel = config.instance("panel-1");
const panelMode = panel.get("mode");
await panel.set("mode", "light");
```

An instance reads its override first and falls back to the base namespace value. Its writes target the instance path.

## Subscribe to Changes

```typescript
const unsubscribe = config.onChange("mode", (nextMode) => {
  if (nextMode !== undefined) {
    document.documentElement.dataset.theme = nextMode;
  }
});

// During application teardown:
unsubscribe();
await client.close();
```

Changes arrive through the configured transport and update the client's local state.

## Offline Persistence

With IndexedDB persistence, the client stores the last snapshot. A later boot can use that snapshot when the server is unavailable if offline boot is enabled. Treat cached data as potentially stale and use the client's `mode`, `lastSyncedAt`, and `staleSince` health properties when presenting offline state.

## Next Steps

- [Backend Client Guide](./backend-client.md) — register service and fragment schemas
- [Server Quickstart](./server-quickstart.md) — run the server used by this client
