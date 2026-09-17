import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import type { WeaverConfigService } from "../src/core/config-service.js";
import { createWeaverConfigService } from "../src/core/config-service.js";
import {
  createPersistentSchemaRegistry,
  createSchemaRegistry,
} from "../src/core/schema-registry.js";

const configService = {} as WeaverConfigService;

function serviceRegistration() {
  return {
    serviceId: "lynx",
    environment: "default",
    owner: { name: "Lynx", contact: "lynx@example.com" },
    schema: { type: "object" as const },
    schemaVersion: "1.2.3",
    fragmentSlots: [{ slotPath: "/plugins", accepts: "object" as const }],
  };
}

function fragmentRegistration(providerId = "ghost.settings.panel") {
  return {
    serviceId: "lynx",
    providerId,
    slotPath: "/plugins",
    environment: "default",
    owner: { name: "Ghost", contact: "ghost@example.com" },
    schema: { type: "object" as const },
    schemaVersion: "0.4.0",
  };
}

describe("SchemaRegistry", () => {
  it("registers service schema metadata with owner, version, and derived paths", async () => {
    const registry = createSchemaRegistry({ configService });
    const result = await registry.register(serviceRegistration(), {
      subject: "svc:lynx",
      actor: "api",
    });

    expect(result.success).toBe(true);
    expect(result.metadata).toEqual({
      serviceId: "lynx",
      servicePath: "/lynx",
      environment: "default",
      providerId: "lynx",
      owner: { name: "Lynx", contact: "lynx@example.com" },
      schemaVersion: "1.2.3",
      audit: { subject: "svc:lynx", actor: "api" },
    });
    expect(await registry.getSchema("lynx", "default")).toEqual({
      type: "object",
    });
    expect(Object.keys(registry.listAll())).toEqual(["/lynx:default"]);
  });

  it("registers fragment schema metadata under a declared slot", async () => {
    const registry = createSchemaRegistry({ configService });
    await registry.register(serviceRegistration());
    const result = await registry.register(fragmentRegistration());

    expect(result.success).toBe(true);
    expect(result.metadata).toEqual({
      serviceId: "lynx",
      servicePath: "/lynx",
      canonicalSlotPath: "/lynx/plugins",
      providerId: "ghost.settings.panel",
      fragmentPath: "/lynx/plugins/ghost.settings.panel",
      environment: "default",
      owner: { name: "Ghost", contact: "ghost@example.com" },
      schemaVersion: "0.4.0",
    });
    expect(Object.keys(registry.listAll())).toEqual([
      "/lynx:default",
      "/lynx/plugins/ghost.settings.panel:default",
    ]);
  });

  it("rejects fragments for unknown slots", async () => {
    const registry = createSchemaRegistry({ configService });
    const result = await registry.register(fragmentRegistration());

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Unknown fragment slot");
  });

  it("rejects duplicate fragment paths in one environment", async () => {
    const registry = createSchemaRegistry({ configService });
    await registry.register(serviceRegistration());
    expect((await registry.register(fragmentRegistration())).success).toBe(
      true,
    );

    const duplicate = await registry.register(fragmentRegistration());

    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.message).toContain(
      "Duplicate fragment registration",
    );
  });

  it("treats service fragmentSlots as authoritative on re-registration", async () => {
    const registry = createSchemaRegistry({ configService });
    await registry.register(serviceRegistration());

    const removal = await registry.register({
      ...serviceRegistration(),
      fragmentSlots: [],
    });
    const fragment = await registry.register(fragmentRegistration());

    expect(removal.success).toBe(true);
    expect(fragment.success).toBe(false);
    expect(fragment.error?.message).toContain("Unknown fragment slot");
  });

  it("rejects slot removal while fragments exist in that slot", async () => {
    const registry = createSchemaRegistry({ configService });
    await registry.register(serviceRegistration());
    await registry.register(fragmentRegistration());

    const removal = await registry.register({
      ...serviceRegistration(),
      fragmentSlots: [],
    });

    expect(removal.success).toBe(false);
    expect(removal.error?.message).toContain("Cannot remove fragment slot");
  });

  it("rejects invalid provider ids and protected service paths", async () => {
    const registry = createSchemaRegistry({ configService });
    await registry.register(serviceRegistration());

    expect(
      (await registry.register(fragmentRegistration("bad/id"))).success,
    ).toBe(false);
    expect(
      (
        await registry.register({
          ...serviceRegistration(),
          serviceId: "_weaver",
          owner: { name: "Internal", contact: "platform@example.com" },
          fragmentSlots: [],
        })
      ).success,
    ).toBe(false);
  });

  it("persists and hydrates registry metadata under the protected internal root", async () => {
    const persistentConfigService = await createWeaverConfigService({
      providers: [
        createInMemoryStorageProvider({
          id: "platform",
          layer: "platform",
          initialEntries: {},
        }),
      ],
      environment: "default",
    });

    const registry = await createPersistentSchemaRegistry({
      configService: persistentConfigService,
    });
    await registry.register(serviceRegistration(), { actor: "api" });

    expect(
      await persistentConfigService.get("_weaver.registry.schemas"),
    ).toEqual({
      environments: {
        default: {
          schemas: {
            "/lynx": {
              kind: "service",
              schema: { type: "object" },
              metadata: {
                serviceId: "lynx",
                servicePath: "/lynx",
                environment: "default",
                providerId: "lynx",
                owner: { name: "Lynx", contact: "lynx@example.com" },
                schemaVersion: "1.2.3",
                audit: { actor: "api" },
              },
            },
          },
          slots: {
            "/lynx/plugins": {
              serviceId: "lynx",
              servicePath: "/lynx",
              slotPath: "/plugins",
              canonicalSlotPath: "/lynx/plugins",
              environment: "default",
              providerId: "lynx",
              owner: { name: "Lynx", contact: "lynx@example.com" },
              accepts: "object",
              schemaVersion: "1.2.3",
              audit: { actor: "api" },
            },
          },
        },
      },
    });

    const hydrated = await createPersistentSchemaRegistry({
      configService: persistentConfigService,
    });
    expect((await hydrated.register(fragmentRegistration())).success).toBe(
      true,
    );
    expect(Object.keys(hydrated.listAll())).toContain(
      "/lynx/plugins/ghost.settings.panel:default",
    );
  });
});
