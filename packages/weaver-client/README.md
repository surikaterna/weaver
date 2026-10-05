# @weaver-conf/weaver-client

> Configuration client SDK for Weaver — compile-time typed views, transports, offline persistence, and real-time sync.

## Installation

```bash
pnpm add @weaver-conf/weaver-client @weaver-conf/config-types
```

## Browser and Node entries

Browser applications must import from `@weaver-conf/weaver-client/browser`.
This explicit ESM/CJS/TypeScript entry exports the same client, transports,
IndexedDB persistence, and supporting APIs as the Node root, except
`createFileSystemPersistence` and `FileSystemPersistenceOptions`. It uses the
same implementations, not filesystem stubs, aliases, or tree-shaking assumptions.

```typescript
import { createWeaverClient, createLocalTransport } from "@weaver-conf/weaver-client/browser";

const client = await createWeaverClient({
  transport: createLocalTransport({
    snapshot: {
      entries: { app: { enabled: true } },
      scopes: {},
      revision: "local-1",
      timestamp: new Date().toISOString(),
    },
  }),
});
const enabled = client.get<boolean>("app.enabled"); // synchronous after boot
await client.close();
```

The local transport is an in-memory/offline helper, **not** a governed policy
adapter. Browser packaging does not confer authorization or provenance semantics.
The existing `@weaver-conf/weaver-client` root remains Node-oriented and retains
real atomic filesystem persistence unchanged; it is not browser-safe. Node
examples below continue to use that root. Browser callers should change only the
import path, and use IndexedDB or a supplied persistence adapter instead of files.

## Register a Runtime Schema

`ConfigurationPropertySchema` is the sole runtime schema model. Pass a `SchemaRegistrationRequest` directly to the client; registration does not convert or infer another schema format.

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
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" },
    retryLimit: { type: "integer", minimum: 0, maximum: 10 },
  },
  additionalProperties: false,
} satisfies ConfigurationPropertySchema;

const request: SchemaRegistrationRequest = {
  serviceId: "my-service",
  environment: "default",
  owner: { name: "My Service", contact: "team@example.com" },
  schema,
  fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
};

const client = await createWeaverClient({
  transport: createHttpTransport({ baseUrl: "http://localhost:3399" }),
});
await client.registerSchema(request);
```

The service request derives the canonical registration anchor `/my-service`. A plugin can register its fragment directly too:

```typescript
const pluginRequest: SchemaRegistrationRequest = {
  serviceId: "my-service",
  providerId: "analytics",
  slotPath: "/plugins",
  environment: "default",
  owner: { name: "Analytics", contact: "analytics@example.com" },
  schema: {
    type: "object",
    properties: { sampleRate: { type: "number", minimum: 0, maximum: 1 } },
    additionalProperties: false,
  },
};

await client.registerSchema(pluginRequest);
await client.close();
```

That fragment's canonical anchor is `/my-service/plugins/analytics`. Canonical slash paths belong to registration. Client access uses storage prefixes and member keys instead: `my-service`, `my-service.enabled`, `my-service.plugins.analytics`, or bracket notation such as `my-service[feature.flag]` for one segment containing a literal dot. Do not pass a slash anchor to `namespace()`, `get()`, or `set()`.

## Create Typed Views

Register schemas before creating clients that fetch them:

```typescript
interface MyConfig {
  enabled: boolean;
  retryLimit: number;
}

const client = await createWeaverClient({
  transport: createHttpTransport({ baseUrl: "http://localhost:3399" }),
  schemas: true,
});

const service = client.namespace<MyConfig>("my-service");
const enabled = service.get("enabled"); // boolean | undefined
await service.set("retryLimit", 5);

const tenantService = service.withScope([
  { scopeId: "tenant", value: "acme" },
]);
const scopedLimit = tenantService.get("retryLimit");

const worker = service.instance("worker-1");
const workerEnabled = worker.get("enabled");
await worker.set("enabled", true);
```

The `MyConfig` generic constrains keys and values only at compile time. It is erased at runtime and does not prove that stored values match the interface. Server-side validation is authoritative; `schemas` adds client-side preflight validation and metadata using the server's registered schemas.

Batch writes (`client.setMany`, `client.setNamespace`, and namespace `setMany`) preflight every entry against the loaded schemas before sending a write. If any entry is invalid, the batch returns `VALIDATION_ERROR` without a transport write. Member names and instance IDs containing literal dots use bracket-safe storage keys, for example `my-service[feature.flag]`, not slash registration anchors.

Types can be handwritten, as above, or produced by external JSON-Schema-to-TypeScript tooling. Weaver ships no generator or Zod adapter in this flow.

## Schema Environments

```typescript
const defaultClient = await createWeaverClient({
  transport: createHttpTransport({ baseUrl: "http://localhost:3399" }),
  schemas: true,
});

const productionClient = await createWeaverClient({
  transport: createHttpTransport({ baseUrl: "http://localhost:3399" }),
  schemas: { environment: "production" },
});
```

`schemas: true` selects the `default` schema registration environment at boot. The object form selects the named environment exactly. This setting chooses validation and metadata schemas; configure value and write routing separately through the relevant transport and write options. `SchemaOptions.live` does not automatically subscribe to schema changes; reboot the client to refresh its schema registry after registration changes.

When migrating from a Zod-based namespace definition, register a `ConfigurationPropertySchema` directly and provide the generic interface yourself (or use external tooling). Weaver does not convert a Zod shape or infer the generic type from the registered schema.

## Main API

- `createWeaverClient(options)` — creates a connected client with optional persistence and schema loading
- `client.namespace<T>(storagePrefix)` — creates a compile-time typed namespace view
- `namespace.withScope(scopePath)` — preserves the namespace type for scoped access
- `client.preloadScope(scopePath)` — loads one scope path on demand; call separately for each scope path to warm
- `namespace.instance(instanceId)` and `client.instance<T>(basePath, instanceId)` — create typed instance views
- `client.registerSchema(request)` — registers a service or fragment JSON Schema request
- `createHttpTransport(options)` and `createLocalTransport(options)` — provide HTTP or in-memory transport
- `createFileSystemPersistence(options)` and `createIndexedDbPersistence(options)` — provide offline cache persistence
- `client.close()` — unsubscribes, disposes the staleness monitor, and closes the transport

## License

MIT
