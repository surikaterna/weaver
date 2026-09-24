# @weaver-conf/weaver-client

> Configuration client SDK for Weaver — compile-time typed views, transports, offline persistence, and real-time sync.

## Installation

```bash
pnpm add @weaver-conf/weaver-client @weaver-conf/config-types
```

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

`schemas: true` selects the `default` schema registration environment. The object form selects the named environment exactly. This setting chooses validation and metadata schemas; configure value and write routing separately through the relevant transport and write options.

## Main API

- `createWeaverClient(options)` — creates a connected client with optional persistence and schema loading
- `client.namespace<T>(storagePrefix)` — creates a compile-time typed namespace view
- `namespace.withScope(scopePath)` — preserves the namespace type for scoped access
- `namespace.instance(instanceId)` and `client.instance<T>(basePath, instanceId)` — create typed instance views
- `client.registerSchema(request)` — registers a service or fragment JSON Schema request
- `createHttpTransport(options)` and `createLocalTransport(options)` — provide HTTP or in-memory transport
- `createFileSystemPersistence(options)` and `createIndexedDbPersistence(options)` — provide offline cache persistence
- `client.close()` — releases subscriptions, monitors, persistence, and transport resources

## License

MIT
