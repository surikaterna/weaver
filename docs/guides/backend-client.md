# Backend Client Guide

Use `@weaver-conf/weaver-client` in a Node.js service for compile-time typed, resilient configuration access.

## Installation

```bash
pnpm add @weaver-conf/weaver-client @weaver-conf/config-types
```

## Register the Service Schema

`ConfigurationPropertySchema` is Weaver's sole runtime schema model. Register a `SchemaRegistrationRequest` directly during deployment or service startup, before schema-enabled consumer clients boot:

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
  required: ["currency", "retryLimit"],
  properties: {
    currency: { type: "string", enum: ["USD", "EUR", "GBP"] },
    retryLimit: { type: "integer", minimum: 0, maximum: 10 },
    webhookUrl: { type: "string", format: "uri" },
  },
  additionalProperties: false,
} satisfies ConfigurationPropertySchema;

const request: SchemaRegistrationRequest = {
  serviceId: "billing-service",
  environment: "default",
  owner: { name: "Billing", contact: "billing@example.com" },
  schema,
  fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
};

const client = await createWeaverClient({
  transport: createHttpTransport({ baseUrl: "http://weaver-server:3399" }),
});
await client.registerSchema(request);
```

This request derives the canonical registration anchor `/billing-service`. A plugin provider can register a fragment at the declared slot:

```typescript
await client.registerSchema({
  serviceId: "billing-service",
  providerId: "fraud-check",
  slotPath: "/plugins",
  environment: "default",
  owner: { name: "Fraud Check", contact: "fraud@example.com" },
  schema: {
    type: "object",
    properties: { threshold: { type: "number", minimum: 0, maximum: 1 } },
    additionalProperties: false,
  },
});
await client.close();
```

The fragment anchor is `/billing-service/plugins/fraud-check`. These canonical slash paths are registration identities. Reads and writes use storage keys such as `billing-service.retryLimit`, `billing-service.plugins.fraud-check.threshold`, or `billing-service[feature.flag]` for a literal-dot segment. Client access APIs do not accept slash paths as aliases.

## Create the Configuration Client

```typescript
import { createFileSystemPersistence } from "@weaver-conf/weaver-client";

const client = await createWeaverClient({
  transport: createHttpTransport({ baseUrl: "http://weaver-server:3399" }),
  persistence: createFileSystemPersistence({ dir: "./.config-cache" }),
  schemas: true,
});
```

`schemas: true` loads the `default` schema environment. Select another registered schema environment explicitly:

```typescript
const productionClient = await createWeaverClient({
  transport: createHttpTransport({ baseUrl: "http://weaver-server:3399" }),
  schemas: { environment: "production" },
});
```

This option selects validation and metadata schemas, not configuration value or write routing. The server remains authoritative for runtime validation.

## Typed, Scoped, and Instance Access

```typescript
interface BillingConfig {
  currency: "USD" | "EUR" | "GBP";
  retryLimit: number;
  webhookUrl: string;
}

const billing = client.namespace<BillingConfig>("billing-service");
const currency = billing.get("currency");
await billing.set("retryLimit", 5);

const tenantBilling = billing.withScope([
  { scopeId: "tenant", value: "acme" },
]);
const tenantCurrency = tenantBilling.get("currency");

const workerBilling = billing.instance("worker-1");
const workerLimit = workerBilling.get("retryLimit");
await workerBilling.set("retryLimit", 3);
```

Generic arguments are erased compile-time assertions. They constrain keys and values in TypeScript but do not validate, parse, or coerce runtime data. Keep the interface aligned manually or generate it with external JSON-Schema-to-TypeScript tooling; Weaver ships no generator or Zod adapter for this flow.

## Subscribe and Shut Down

```typescript
const unsubscribe = billing.onChange("retryLimit", (nextLimit) => {
  if (nextLimit !== undefined) retryPolicy.maxAttempts = nextLimit;
});

process.on("SIGTERM", async () => {
  unsubscribe();
  await client.close();
  process.exit(0);
});
```

Filesystem persistence stores the last snapshot for offline boot. Change subscriptions update the local state through the configured transport.

## Next Steps

- [Browser Client Guide](./browser-client.md) — consume registered schemas in a browser
- [Server Quickstart](./server-quickstart.md) — configure the server used by this client
