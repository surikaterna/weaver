import { withAuth } from "@weaver-conf/config-auth";
import type {
  ConfigurationPropertySchema,
  WeaverConfig,
} from "@weaver-conf/config-types";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { vi } from "vitest";
import { createTestService } from "../../test/setup-service";
import type { AuthContext } from "../auth/auth-middleware";
import { createSchemaRegistry } from "../core/schema-registry";
import { createAuthGate } from "./auth-gate";
import { createRestAdapter, type RestRequest } from "./rest-adapter";

function context(role: string, service = false): AuthContext {
  return {
    identity: { userId: role, roles: [role], claims: {} },
    isAdmin: role === "admin",
    isService: service,
    isUser: !service,
  };
}

function request(authContext?: AuthContext): RestRequest {
  return {
    params: {},
    headers: {},
    query: {},
    ...(authContext ? { authContext } : {}),
  };
}

function productionGate(explicitAdminPolicy = false) {
  const weaverConfig: WeaverConfig = {
    layers: [],
    layerNames: [],
    rankMap: new Map(),
    getRank: () => 0,
    getLayer: () => undefined,
    getLayersByType: () => [],
  };
  return createAuthGate({
    authFunctions: withAuth({
      weaverConfig,
      visibilityRoles: {
        admin: new Set(["admin"]),
        platform: new Set(["admin"]),
      },
      layerWritePolicies: explicitAdminPolicy
        ? [{ layer: "admin", allowedRoles: ["admin"] }]
        : [],
      dynamicScopeRoles: new Set(["reader", "admin"]),
    }),
    mapContext: (ctx) => ({
      userId: ctx.identity.userId ?? "service",
      roles: ctx.identity.roles ?? [],
    }),
  });
}

function registration(kind: string, service = false) {
  const common = {
    serviceId: "svc",
    environment: "dev",
    owner: { name: "team", contact: "team@example.com" },
    schema: { type: "object", properties: { plugins: { type: "object" } } },
  };
  return kind === "services"
    ? {
        ...common,
        fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
      }
    : {
        ...common,
        providerId: service ? "service-plugin" : "plugin",
        slotPath: "/plugins",
      };
}

async function deniedRequests(adapter: ReturnType<typeof createRestAdapter>) {
  for (const kind of ["services", "fragments"]) {
    const identities = [undefined, context("reader"), context("reader", true)];
    for (const identity of identities) {
      const response = await adapter.handleRequest(
        "POST",
        `/v1/admin/schemas/${kind}`,
        {
          ...request(identity),
          body: {
            get serviceId(): unknown {
              throw new Error("Denied request body parsed");
            },
          },
        },
      );
      expect(response.status).toBe(identity ? 403 : 401);
    }
  }
}

describe("schema registration explicit admin boundary (weaver-3ax)", () => {
  it.each([
    false,
    true,
  ])("denies before effects with admin policy=%s", async (explicit) => {
    const configService = await createTestService(
      {
        environment: "dev",
        providers: [],
      },
      {},
    );
    const schemaRegistry = createSchemaRegistry({ configService });
    const register = vi.spyOn(schemaRegistry, "register");
    const gate = productionGate(explicit);
    const gateWrite = vi.spyOn(gate, "gateWrite");
    const record = vi.fn(async () => {});
    for (const registry of [schemaRegistry, undefined]) {
      const adapter = createRestAdapter({
        configService,
        ...(registry ? { schemaRegistry: registry } : {}),
        authGate: gate,
        auditService: { record },
      });
      await deniedRequests(adapter);
    }
    expect(register).not.toHaveBeenCalled();
    expect(gateWrite).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(schemaRegistry.listAll()).toEqual({});
  });

  it.each([
    false,
    true,
  ])("allows admins with admin policy=%s", async (explicit) => {
    const configService = await createTestService(
      {
        environment: "dev",
        providers: [],
      },
      {},
    );
    const schemaRegistry = createSchemaRegistry({ configService });
    const adapter = createRestAdapter({
      configService,
      schemaRegistry,
      authGate: productionGate(explicit),
    });
    for (const kind of ["services", "fragments"]) {
      for (const service of [false, true]) {
        const response = await adapter.handleRequest(
          "POST",
          `/v1/admin/schemas/${kind}`,
          {
            ...request(context("admin", service)),
            body: registration(kind, service),
          },
        );
        expect(response.status).toBe(201);
      }
      const malformed = await adapter.handleRequest(
        "POST",
        `/v1/admin/schemas/${kind}`,
        { ...request(context("admin")), body: {} },
      );
      expect(malformed.status).toBe(400);
    }
  });
});

async function visibilityService() {
  const entries = {
    visible: { value: "BASE" },
    hidden: { value: "BASE_SECRET" },
    internal: { value: "INTERNAL_SECRET" },
  };
  return createTestService(
    {
      environment: "dev",
      providers: [
        createInMemoryStorageProvider({
          id: "base",
          layer: "platform",
          initialEntries: entries,
        }),
        createInMemoryStorageProvider({
          id: "tenant",
          layer: "tenant:acme",
          initialEntries: { hidden: { value: "TENANT_SECRET" } },
        }),
        createInMemoryStorageProvider({
          id: "region",
          layer: "region:eu",
          initialEntries: {
            visible: { value: "EU" },
            hidden: { value: "REGION_SECRET" },
          },
        }),
      ],
    },
    {
      visible: {
        type: "object",
        properties: { value: { type: "string" } },
        additionalProperties: false,
        description: "PROTECTED",
      },
      hidden: {
        type: "object",
        properties: { value: { type: "string" } },
        additionalProperties: false,
      },
      internal: {
        type: "object",
        properties: { value: { type: "string" } },
        additionalProperties: false,
      },
    },
    [
      [{ scopeId: "tenant", value: "acme" }],
      [
        { scopeId: "tenant", value: "acme" },
        { scopeId: "region", value: "eu" },
      ],
    ],
  );
}

describe("REST scoped visibility (weaver-xusf)", () => {
  const schemaMap = new Map<string, ConfigurationPropertySchema>([
    ["hidden", { type: "object", "x-weaver": { visibility: "admin" } }],
    ["internal", { type: "object", "x-weaver": { visibility: "platform" } }],
  ]);

  it.each([
    undefined,
    "tenant:acme",
    "tenant:acme,region:eu",
  ])("filters scope=%s", async (scope) => {
    const configService = await visibilityService();
    const adapter = createRestAdapter({
      configService,
      authGate: productionGate(),
    });
    for (const role of ["reader", "admin"]) {
      const response = await adapter.handleRequest("GET", "/v1/config", {
        ...request(context(role)),
        query: scope === undefined ? {} : { scope },
        schemaMap,
      });
      expect(response.status).toBe(200);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain("PROTECTED");
      if (role === "reader") expect(serialized).not.toContain("SECRET");
      else {
        expect(serialized).toContain(
          scope?.includes(",") ? "REGION_SECRET" : "TENANT_SECRET",
        );
      }
      expect(response.body).toMatchObject({
        data: {
          entries: { visible: { value: "BASE" } },
          revision: configService.revision,
          scopes: scope?.includes(",")
            ? { "tenant:acme/region:eu": { visible: { value: "EU" } } }
            : { "tenant:acme": { visible: { value: "BASE" } } },
        },
      });
    }
  });

  it("honors custom filters independently for base and each scope", async () => {
    const configService = await visibilityService();
    const gate = productionGate();
    const filterVisible = vi.fn((_ctx, entries: Record<string, unknown>) => ({
      visible: entries.visible,
    }));
    const adapter = createRestAdapter({
      configService,
      authGate: { ...gate, filterVisible },
    });
    const response = await adapter.handleRequest("GET", "/v1/config", {
      ...request(context("reader")),
      schemaMap,
    });
    expect(filterVisible).toHaveBeenCalledTimes(3);
    expect(response.body).toMatchObject({
      data: {
        entries: { visible: { value: "BASE" } },
        scopes: {
          "tenant:acme": { visible: { value: "BASE" } },
          "tenant:acme/region:eu": { visible: { value: "EU" } },
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("SECRET");
  });
});
