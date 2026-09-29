import { registeredSchemaIdentityPageResponseSchema } from "@weaver-conf/config-types";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../core/config-service";
import { createSchemaRegistry } from "../core/schema-registry";
import { createScopeManager } from "../core/scope-manager";
import { createWeaverScompService } from "./scomp-service";

describe("trusted SCOMP schema browsing", () => {
  it("projects identities and returns only exact registered details", async () => {
    const configService = await createWeaverConfigService({
      environment: "dev",
      providers: [
        createInMemoryStorageProvider({ id: "test", layer: "platform" }),
      ],
    });
    const schemaRegistry = createSchemaRegistry({ configService });
    const schema = {
      type: "object" as const,
      properties: { enabled: { type: "boolean" as const } },
    };
    await schemaRegistry.register({
      serviceId: "app",
      environment: "dev",
      owner: { name: "App", contact: "app@example.com" },
      schema,
      fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
    });
    const scopeManager = createScopeManager({ configService, schemaRegistry });
    const service = createWeaverScompService({
      configService,
      scopeManager,
      schemaRegistry,
      defaultEnvironment: "dev",
    });
    const list =
      service.router["weaver-config-v1.listRegisteredSchemaIdentities"];
    const detail = service.router["weaver-config-v1.getRegisteredSchema"];
    const page =
      service.router["weaver-config-v1.listRegisteredSchemaIdentityPage"];
    const first = registeredSchemaIdentityPageResponseSchema.parse(
      await page?.handler({ limit: 1 }),
    );
    expect(first.anchors).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const second = registeredSchemaIdentityPageResponseSchema.parse(
      await page?.handler({ cursor: first.nextCursor ?? "" }),
    );
    expect(second.slots).toHaveLength(1);
    await expect(page?.handler({ limit: 201 })).rejects.toThrow();
    expect(await list?.handler({})).toEqual({
      anchors: [{ kind: "service", path: "/app", environment: "dev" }],
      slots: [
        {
          kind: "slot",
          path: "/app/plugins",
          environment: "dev",
          accepts: "object",
        },
      ],
    });
    expect(
      await detail?.handler({ anchorPath: "/app", environment: "dev" }),
    ).toMatchObject({
      kind: "service",
      schema,
      metadata: { owner: { name: "App" } },
    });
    await expect(
      detail?.handler({ anchorPath: "/app/child", environment: "dev" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      detail?.handler({ anchorPath: "/app", environment: "other" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      detail?.handler({ anchorPath: "/app/", environment: "dev" }),
    ).rejects.toThrow();
  });
});
