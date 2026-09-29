import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../core/config-service";
import { createSchemaRegistry } from "../core/schema-registry";
import { createScopeManager } from "../core/scope-manager";
import { createRestAdapter } from "./rest-adapter";
import { createWeaverScompService } from "./scomp-service";

async function collidingRegistry() {
  const configService = await createWeaverConfigService({
    environment: "default",
    providers: [
      createInMemoryStorageProvider({ id: "platform", layer: "platform" }),
    ],
  });
  const schemaRegistry = createSchemaRegistry({ configService });
  const owner = { name: "test", contact: "test@example.org" };
  const schema = { type: "object" as const };
  for (const { environment, slotPath } of [
    { environment: "prod/dev:x", slotPath: "/plugins" },
    { environment: "x", slotPath: "/plugins/p:prod" },
  ]) {
    const result = await schemaRegistry.register({
      serviceId: "svc",
      environment,
      owner,
      schema,
      fragmentSlots: [{ slotPath, accepts: "object" }],
    });
    expect(result.success).toBe(true);
  }
  for (const { environment, slotPath, providerId } of [
    { environment: "prod/dev:x", slotPath: "/plugins", providerId: "p" },
    { environment: "x", slotPath: "/plugins/p:prod", providerId: "dev" },
  ]) {
    const result = await schemaRegistry.register({
      serviceId: "svc",
      environment,
      slotPath,
      providerId,
      owner,
      schema,
    });
    expect(result.success).toBe(true);
  }
  return { configService, schemaRegistry };
}

it("fails ambiguous REST bulk but serves targeted identities and detail", async () => {
  const { configService, schemaRegistry } = await collidingRegistry();
  const rest = createRestAdapter({ configService, schemaRegistry });
  const request = { params: {}, query: {}, headers: {} };
  const bulk = await rest.handleRequest("GET", "/v1/admin/schemas", request);
  expect(bulk.status).toBe(409);
  expect(bulk.body).toMatchObject({ error: { code: "SCHEMA_CONFLICT" } });
  expect(JSON.stringify(bulk.body)).not.toContain('"schemas"');
  const identities = await rest.handleRequest(
    "GET",
    "/v1/admin/schemas/identities",
    request,
  );
  expect(identities.status).toBe(200);
  expect(identities.body).toMatchObject({
    data: {
      anchors: expect.arrayContaining([
        { kind: "fragment", path: "/svc/plugins/p", environment: "prod/dev:x" },
        { kind: "fragment", path: "/svc/plugins/p:prod/dev", environment: "x" },
      ]),
    },
  });
  const detail = await rest.handleRequest(
    "GET",
    "/v1/admin/schemas/anchors/svc/plugins/p:prod/dev",
    { ...request, query: { env: "x" } },
  );
  expect(detail.status).toBe(200);
});

it("fails ambiguous SCOMP bulk but serves targeted detail", async () => {
  const { configService, schemaRegistry } = await collidingRegistry();
  const scopeManager = createScopeManager({ configService, schemaRegistry });
  const scomp = createWeaverScompService({
    configService,
    schemaRegistry,
    scopeManager,
    defaultEnvironment: "default",
  });
  await expect(
    scomp.router["weaver-config-v1.fetchSchemas"]?.handler({}),
  ).rejects.toMatchObject({ code: "SCHEMA_CONFLICT" });
  expect(
    await scomp.router["weaver-config-v1.getRegisteredSchema"]?.handler({
      anchorPath: "/svc/plugins/p",
      environment: "prod/dev:x",
    }),
  ).toMatchObject({ path: "/svc/plugins/p" });
});
