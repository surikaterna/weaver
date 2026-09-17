import { withAuth } from "@weaver-conf/config-auth";
import type { WeaverConfig, WriteResult } from "@weaver-conf/config-types";
import type { AuthContext } from "../auth/auth-middleware";
import type { WeaverConfigService } from "../core/config-service";
import type { SchemaRegistry } from "../core/schema-registry";
import { createAuthGate } from "./auth-gate";
import { createRestAdapter } from "./rest-adapter";

const nonAdminContext: AuthContext = {
  identity: { userId: "reader", roles: ["reader"], claims: {} },
  isAdmin: false,
  isService: false,
  isUser: true,
};

const adminContext: AuthContext = {
  identity: { userId: "operator", roles: ["admin"], claims: {} },
  isAdmin: true,
  isService: false,
  isUser: true,
};

describe("GET /v1/admin/schemas authorization", () => {
  it("requires authentication and admin identity before registry access", async () => {
    let listCalls = 0;
    const adapter = createRestAdapter({
      configService: createConfigService(),
      schemaRegistry: createRegistry(() => {
        listCalls += 1;
      }),
      authGate: createProductionAuthGate(),
    });

    const unauthenticated = await request(adapter);
    expect(unauthenticated.status).toBe(401);
    expect(listCalls).toBe(0);

    const nonAdmin = await request(adapter, nonAdminContext);
    expect(nonAdmin.status).toBe(403);
    expect(listCalls).toBe(0);

    const admin = await request(adapter, adminContext);
    expect(admin.status).toBe(200);
    expect(listCalls).toBe(1);
  });
});

function createProductionAuthGate() {
  const layerRanks = new Map([["platform", 0]]);
  const weaverConfig: WeaverConfig = {
    layers: [],
    layerNames: ["platform"],
    rankMap: layerRanks,
    getRank: (layer) => layerRanks.get(layer) ?? -1,
    getLayer: () => undefined,
    getLayersByType: () => [],
  };
  const authFunctions = withAuth({
    weaverConfig,
    visibilityRoles: {
      admin: new Set(["admin"]),
      platform: new Set(["admin", "platform"]),
    },
    layerWritePolicies: [{ layer: "platform", allowedRoles: ["admin"] }],
    dynamicScopeRoles: new Set(["admin"]),
  });
  return createAuthGate({
    authFunctions,
    mapContext: (context) => ({
      userId:
        context.identity.userId ?? context.identity.serviceId ?? "anonymous",
      roles: context.identity.roles ?? [],
    }),
  });
}

function createRegistry(onList: () => void): SchemaRegistry {
  return {
    register: async () => ({
      success: false,
      isNewSchema: false,
      hasBreakingChanges: false,
      error: { code: "INTERNAL_ERROR", message: "not used" },
    }),
    getSchema: async () => null,
    resolveAnchor: async () => null,
    listAll: () => {
      onList();
      return {};
    },
  };
}

function createConfigService(): WeaverConfigService {
  const writeResult = (): WriteResult => ({ success: true, revision: "test" });
  return {
    providers: [],
    degradedProviders: [],
    revision: "test",
    resolveAll: async () => ({
      entries: {},
      scopes: {},
      revision: "test",
      timestamp: new Date().toISOString(),
    }),
    get: async () => undefined,
    getNamespace: async () => ({}),
    inspect: async () => ({
      key: "",
      effectiveValue: undefined,
      effectiveLayer: undefined,
      layerValues: {},
    }),
    reloadProvider: async () => {},
    set: async () => writeResult(),
    remove: async () => writeResult(),
    onDelta: () => () => {},
    batch: async <T>(fn: () => Promise<T>) => fn(),
    setMany: async () => writeResult(),
    setRegisteredObject: async () => writeResult(),
    patchRegisteredPath: async () => writeResult(),
    validateRegisteredEffective: async () => ({ valid: true, errors: [] }),
    flush: async () => {},
    refreshProviders: async () => {},
  };
}

type TestAdapter = ReturnType<typeof createRestAdapter>;

async function request(adapter: TestAdapter, authContext?: AuthContext) {
  return adapter.handleRequest("GET", "/v1/admin/schemas", {
    params: {},
    query: {},
    headers: {},
    ...(authContext ? { authContext } : {}),
  });
}
