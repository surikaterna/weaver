import { createAuthGate } from "../../src/transport/auth-gate";

const mockAuthFunctions = {
  canRead(accessCtx, _key, schema) {
    if (!schema) return true;
    const visibility = schema["x-weaver"]?.visibility ?? "public";
    if (visibility === "internal") return false;
    if (visibility === "admin") return accessCtx.roles.includes("admin");
    return true;
  },
  canWrite(accessCtx, _layer, _key, _schema) {
    return accessCtx.roles.includes("admin");
  },
  filterVisibleKeys(accessCtx, entries, schemaMap) {
    const result = {};
    for (const key of Object.keys(entries)) {
      const schema = schemaMap.get(key);
      if (mockAuthFunctions.canRead(accessCtx, key, schema)) {
        result[key] = entries[key];
      }
    }
    return result;
  },
};

const mapContext = (authCtx) => ({
  userId: authCtx.identity?.userId ?? "anonymous",
  roles: authCtx.identity?.roles ?? [],
  sessionMode: undefined,
});

test("toAccessContext maps AuthContext correctly", () => {
  const gate = createAuthGate({ authFunctions: mockAuthFunctions, mapContext });
  const authCtx = {
    identity: { userId: "user-1", roles: ["admin", "viewer"] },
    isAdmin: true,
    isService: false,
    isUser: true,
  };
  const accessCtx = gate.toAccessContext(authCtx);
  expect(accessCtx.userId).toBe("user-1");
  expect(accessCtx.roles).toEqual(["admin", "viewer"]);
});

test("gateRead returns null when access is allowed", () => {
  const gate = createAuthGate({ authFunctions: mockAuthFunctions, mapContext });
  const accessCtx = { userId: "u1", roles: ["admin"], sessionMode: undefined };
  const result = gate.gateRead(accessCtx, "some.key", undefined);
  expect(result).toBe(null);
});

test("gateRead returns 403 when access is denied", () => {
  const gate = createAuthGate({ authFunctions: mockAuthFunctions, mapContext });
  const accessCtx = { userId: "u1", roles: ["viewer"], sessionMode: undefined };
  const schema = { "x-weaver": { visibility: "internal" } };
  const result = gate.gateRead(accessCtx, "secret.key", schema);
  expect(result).not.toBe(null);
  expect(result.status).toBe(403);
});

test("gateWrite returns null when write is allowed", () => {
  const gate = createAuthGate({ authFunctions: mockAuthFunctions, mapContext });
  const accessCtx = { userId: "u1", roles: ["admin"], sessionMode: undefined };
  const result = gate.gateWrite(accessCtx, "platform", "some.key", undefined);
  expect(result).toBe(null);
});

test("gateWrite returns 403 when write is denied", () => {
  const gate = createAuthGate({ authFunctions: mockAuthFunctions, mapContext });
  const accessCtx = { userId: "u1", roles: ["viewer"], sessionMode: undefined };
  const result = gate.gateWrite(accessCtx, "platform", "some.key", undefined);
  expect(result).not.toBe(null);
  expect(result.status).toBe(403);
});

test("filterVisible removes non-visible keys", () => {
  const gate = createAuthGate({ authFunctions: mockAuthFunctions, mapContext });
  const accessCtx = { userId: "u1", roles: ["viewer"], sessionMode: undefined };
  const entries = { "public.key": "val1", "secret.key": "val2" };
  const schemaMap = new Map();
  schemaMap.set("secret.key", { "x-weaver": { visibility: "internal" } });
  const result = gate.filterVisible(accessCtx, entries, schemaMap);
  expect(result["public.key"]).toBe("val1");
  expect(result["secret.key"]).toBe(undefined);
});

test("filterVisible cannot reintroduce protected metadata", () => {
  const authFunctions = {
    ...mockAuthFunctions,
    filterVisibleKeys(_accessCtx, entries) {
      return { ...entries, _weaver: { registry: "private" } };
    },
  };
  const gate = createAuthGate({ authFunctions, mapContext });
  const accessCtx = { userId: "u1", roles: ["admin"], sessionMode: undefined };

  expect(
    gate.filterVisible(
      accessCtx,
      { public: true, _weaver: { registry: "private" } },
      new Map(),
    ),
  ).toEqual({ public: true });
});
