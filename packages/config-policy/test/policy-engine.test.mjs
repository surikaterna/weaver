import { evaluateChangePolicy } from "../dist/index.js";
import { withAuth } from "@weaver-conf/config-auth";
import { defineWeaver, Layers } from "@weaver-conf/config-types";

// --- Test WeaverConfig and AuthConfig for canWrite injection ---

const testConfig = defineWeaver([
  Layers.Static("core"),
  Layers.Static("app"),
  Layers.Static("module"),
  Layers.Static("integrator"),
  Layers.Static("tenant"),
  Layers.Static("user"),
  Layers.Static("device"),
  Layers.Ephemeral("session"),
]);

const testAuth = withAuth({
  weaverConfig: testConfig,
  visibilityRoles: {
    admin: new Set(["tenant-admin", "platform-ops", "support"]),
    platform: new Set(["platform-ops"]),
  },
  layerWritePolicies: [
    { layer: "core", allowedRoles: ["system"] },
    { layer: "app", allowedRoles: ["platform-ops", "system"] },
    { layer: "module", allowedRoles: ["system"] },
    { layer: "integrator", allowedRoles: ["platform-ops", "integrator"] },
    { layer: "tenant", allowedRoles: ["platform-ops", "tenant-admin"] },
    { layer: "user", allowedRoles: ["user", "platform-ops", "support"] },
    { layer: "device", allowedRoles: ["user"] },
    { layer: "session", allowedRoles: ["platform-ops", "support"] },
  ],
  dynamicScopeRoles: new Set(["scope-admin", "tenant-admin", "platform-ops"]),
  sessionLayer: "session",
});

// Helpers — minimal context and schema builders
function makeContext(overrides = {}) {
  return {
    userId: "u1",
    tenantId: "t1",
    roles: ["platform-ops"],
    ...overrides,
  };
}

function makeSchema(xWeaver = {}) {
  return { type: "string", "x-weaver": xWeaver };
}

// --- Tests ---

test("direct-allowed policy returns allowed", () => {
  const result = evaluateChangePolicy(
    makeSchema({ changePolicy: "direct-allowed" }),
    makeContext(),
    "app",
    testAuth.canWrite,
  );
  expect(result).toEqual({ outcome: "allowed" });
});

test("staging-gate policy returns requires-promotion", () => {
  const result = evaluateChangePolicy(
    makeSchema({ changePolicy: "staging-gate" }),
    makeContext(),
    "app",
    testAuth.canWrite,
  );
  expect(result.outcome).toBe("requires-promotion");
  expect(result.message.includes("staging")).toBeTruthy();
});

test("full-pipeline policy returns requires-promotion", () => {
  const result = evaluateChangePolicy(
    makeSchema({ changePolicy: "full-pipeline" }),
    makeContext(),
    "app",
    testAuth.canWrite,
  );
  expect(result.outcome).toBe("requires-promotion");
  expect(result.message.includes("CI/CD")).toBeTruthy();
});

test("emergency-override without session flag returns requires-emergency-auth", () => {
  const result = evaluateChangePolicy(
    makeSchema({ changePolicy: "emergency-override" }),
    makeContext(),
    "app",
    testAuth.canWrite,
  );
  expect(result.outcome).toBe("requires-emergency-auth");
  expect(result.message.includes("emergency")).toBeTruthy();
});

test("emergency-override with session flag and reason returns allowed", () => {
  const result = evaluateChangePolicy(
    makeSchema({ changePolicy: "emergency-override" }),
    makeContext({
      trustedSession: { id: "verified", emergency: true, reason: "Production incident #1234" },
    }),
    "app",
    testAuth.canWrite,
  );
  expect(result).toEqual({ outcome: "allowed" });
});

test("canWrite denied returns denied outcome", () => {
  // user role cannot write to core layer
  const result = evaluateChangePolicy(
    makeSchema({ changePolicy: "direct-allowed" }),
    makeContext({ roles: ["user"] }),
    "core",
    testAuth.canWrite,
  );
  expect(result.outcome).toBe("denied");
  expect(result.reason.includes("denied")).toBeTruthy();
});

test("missing changePolicy defaults to direct-allowed", () => {
  const result = evaluateChangePolicy(
    makeSchema(), // no changePolicy field
    makeContext(),
    "app",
    testAuth.canWrite,
  );
  expect(result).toEqual({ outcome: "allowed" });
});

test("emergency-override without reason returns requires-emergency-auth", () => {
  const result = evaluateChangePolicy(
    makeSchema({ changePolicy: "emergency-override" }),
    makeContext({ trustedSession: { id: "verified", emergency: true } }),
    "app",
    testAuth.canWrite,
  );
  expect(result.outcome).toBe("requires-emergency-auth");
});

test("emergency-override with empty reason returns requires-emergency-auth", () => {
  const result = evaluateChangePolicy(
    makeSchema({ changePolicy: "emergency-override" }),
    makeContext({ trustedSession: { id: "verified", emergency: true, reason: "" } }),
    "app",
    testAuth.canWrite,
  );
  expect(result.outcome).toBe("requires-emergency-auth");
});
