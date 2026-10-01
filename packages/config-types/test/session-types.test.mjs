
import {
  propertySessionModeSchema,
  overrideSessionSchema,
  sessionActivationRequestSchema,
  sessionDeactivationResultSchema,
  configurationPropertySchemaSchema,
  sessionTypeSchema,
  sessionModeSchema,
} from "../src/index.ts";

// --- PropertySessionMode / sessionMode on property schema ---

test("propertySessionModeSchema accepts valid values", () => {
  for (const mode of ["allowed", "restricted", "blocked"]) {
    const result = propertySessionModeSchema.safeParse(mode);
    expect(result.success).toBe(true);
  }
});

test("propertySessionModeSchema rejects invalid values", () => {
  for (const bad of ["", 42, null]) {
    const result = propertySessionModeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  }
});

test("sessionTypeSchema accepts any string value", () => {
  for (const t of ["debug", "god-mode", "preview", "support", "custom-type", "anything"]) {
    const result = sessionTypeSchema.safeParse(t);
    expect(result.success).toBe(true);
  }
});

test("sessionTypeSchema rejects non-string values", () => {
  for (const bad of [42, null, true, undefined, {}]) {
    const result = sessionTypeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  }
});

test("sessionModeSchema is an alias for sessionTypeSchema", () => {
  // Deprecated alias should still work
  for (const t of ["debug", "god-mode", "preview", "support"]) {
    const result = sessionModeSchema.safeParse(t);
    expect(result.success).toBe(true);
  }
});

test("configurationPropertySchemaSchema accepts sessionMode field", () => {
  const schema = {
    type: "string",
    default: "dark",
    "x-weaver": { sessionMode: "allowed" },
  };
  const result = configurationPropertySchemaSchema.safeParse(schema);
  expect(result.success).toBe(true);
});

test("configurationPropertySchemaSchema accepts all sessionMode values", () => {
  for (const mode of ["allowed", "restricted", "blocked"]) {
    const schema = { type: "boolean", "x-weaver": { sessionMode: mode } };
    const result = configurationPropertySchemaSchema.safeParse(schema);
    expect(result.success).toBe(true);
  }
});

test("configurationPropertySchemaSchema rejects invalid sessionMode", () => {
  const schema = { type: "string", "x-weaver": { sessionMode: "invalid" } };
  const result = configurationPropertySchemaSchema.safeParse(schema);
  expect(result.success).toBe(false);
});

test("configurationPropertySchemaSchema works without sessionMode", () => {
  const schema = { type: "string", default: "value" };
  const result = configurationPropertySchemaSchema.safeParse(schema);
  expect(result.success).toBe(true);
});

// --- OverrideSession ---

test("overrideSessionSchema accepts a valid session", () => {
  const session = {
    id: "session-abc-123",
    activatedAt: "2026-04-13T10:00:00Z",
    expiresAt: "2026-04-13T14:00:00Z",
    activatedBy: "ops-admin",
    reason: "Production debugging incident #42",
    isActive: true,
    overrides: {
      "example.debug.enabled": true,
      "example.log.level": "verbose",
    },
  };

  const result = overrideSessionSchema.safeParse(session);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(session);
});

test("overrideSessionSchema accepts session with empty overrides", () => {
  const session = {
    id: "session-new",
    activatedAt: "2026-04-13T10:00:00Z",
    expiresAt: "2026-04-13T14:00:00Z",
    activatedBy: "user-1",
    reason: "Testing",
    isActive: false,
    overrides: {},
  };

  const result = overrideSessionSchema.safeParse(session);
  expect(result.success).toBe(true);
});

test("overrideSessionSchema rejects missing required fields", () => {
  const cases = [
    { field: "id", data: { activatedAt: "t", expiresAt: "t", activatedBy: "u", reason: "r", isActive: true, overrides: {} } },
    { field: "activatedAt", data: { id: "1", expiresAt: "t", activatedBy: "u", reason: "r", isActive: true, overrides: {} } },
    { field: "expiresAt", data: { id: "1", activatedAt: "t", activatedBy: "u", reason: "r", isActive: true, overrides: {} } },
    { field: "activatedBy", data: { id: "1", activatedAt: "t", expiresAt: "t", reason: "r", isActive: true, overrides: {} } },
    { field: "reason", data: { id: "1", activatedAt: "t", expiresAt: "t", activatedBy: "u", isActive: true, overrides: {} } },
    { field: "isActive", data: { id: "1", activatedAt: "t", expiresAt: "t", activatedBy: "u", reason: "r", overrides: {} } },
    { field: "overrides", data: { id: "1", activatedAt: "t", expiresAt: "t", activatedBy: "u", reason: "r", isActive: true } },
  ];

  for (const { field, data } of cases) {
    const result = overrideSessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  }
});

test("overrideSessionSchema rejects extra properties (strict)", () => {
  const session = {
    id: "session-1",
    activatedAt: "2026-04-13T10:00:00Z",
    expiresAt: "2026-04-13T14:00:00Z",
    activatedBy: "user-1",
    reason: "Test",
    isActive: true,
    overrides: {},
    extraField: "not-allowed",
  };

  const result = overrideSessionSchema.safeParse(session);
  expect(result.success).toBe(false);
});

// --- SessionActivationRequest ---

test("sessionActivationRequestSchema accepts minimal request", () => {
  const request = { reason: "Investigating incident #99" };
  const result = sessionActivationRequestSchema.safeParse(request);
  expect(result.success).toBe(true);
  expect(result.data.reason).toBe("Investigating incident #99");
});

test("sessionActivationRequestSchema accepts request with durationMs", () => {
  const request = { reason: "Quick debug", durationMs: 1800000 };
  const result = sessionActivationRequestSchema.safeParse(request);
  expect(result.success).toBe(true);
  expect(result.data.durationMs).toBe(1800000);
});

test("sessionActivationRequestSchema accepts request with elevatedAuth", () => {
  const request = {
    reason: "Restricted key override",
    elevatedAuth: { token: "jwt-abc-123", method: "yubikey" },
  };
  const result = sessionActivationRequestSchema.safeParse(request);
  expect(result.success).toBe(true);
  expect(result.data.elevatedAuth).toEqual({ token: "jwt-abc-123", method: "yubikey" });
});

test("sessionActivationRequestSchema accepts full request", () => {
  const request = {
    reason: "Full debug session",
    durationMs: 7200000,
    elevatedAuth: { token: "token-xyz", method: "mfa" },
  };
  const result = sessionActivationRequestSchema.safeParse(request);
  expect(result.success).toBe(true);
});

test("sessionActivationRequestSchema rejects missing reason", () => {
  const result = sessionActivationRequestSchema.safeParse({});
  expect(result.success).toBe(false);
});

test("sessionActivationRequestSchema rejects invalid elevatedAuth shape", () => {
  const request = {
    reason: "test",
    elevatedAuth: { token: "abc" }, // missing method
  };
  const result = sessionActivationRequestSchema.safeParse(request);
  expect(result.success).toBe(false);
});

test("sessionActivationRequestSchema rejects extra properties on elevatedAuth (strict)", () => {
  const request = {
    reason: "test",
    elevatedAuth: { token: "abc", method: "key", extra: true },
  };
  const result = sessionActivationRequestSchema.safeParse(request);
  expect(result.success).toBe(false);
});

// --- SessionDeactivationResult ---

test("sessionDeactivationResultSchema accepts a valid result", () => {
  const deactivation = {
    sessionId: "session-abc-123",
    deactivatedAt: "2026-04-13T14:00:00Z",
    overridesCleared: 5,
    auditRecorded: true,
  };

  const result = sessionDeactivationResultSchema.safeParse(deactivation);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(deactivation);
});

test("sessionDeactivationResultSchema accepts zero overrides cleared", () => {
  const deactivation = {
    sessionId: "session-empty",
    deactivatedAt: "2026-04-13T14:00:00Z",
    overridesCleared: 0,
    auditRecorded: false,
  };

  const result = sessionDeactivationResultSchema.safeParse(deactivation);
  expect(result.success).toBe(true);
});

test("sessionDeactivationResultSchema rejects missing required fields", () => {
  const cases = [
    { field: "sessionId", data: { deactivatedAt: "t", overridesCleared: 0, auditRecorded: true } },
    { field: "deactivatedAt", data: { sessionId: "s", overridesCleared: 0, auditRecorded: true } },
    { field: "overridesCleared", data: { sessionId: "s", deactivatedAt: "t", auditRecorded: true } },
    { field: "auditRecorded", data: { sessionId: "s", deactivatedAt: "t", overridesCleared: 0 } },
  ];

  for (const { field, data } of cases) {
    const result = sessionDeactivationResultSchema.safeParse(data);
    expect(result.success).toBe(false);
  }
});

test("sessionDeactivationResultSchema rejects extra properties (strict)", () => {
  const deactivation = {
    sessionId: "session-1",
    deactivatedAt: "2026-04-13T14:00:00Z",
    overridesCleared: 3,
    auditRecorded: true,
    extraField: "not-allowed",
  };

  const result = sessionDeactivationResultSchema.safeParse(deactivation);
  expect(result.success).toBe(false);
});

// --- Round-trip tests ---

test("OverrideSession round-trip: construct, validate, check fields", () => {
  const input = {
    id: "rt-session-1",
    activatedAt: new Date("2026-04-13T10:00:00Z").toISOString(),
    expiresAt: new Date("2026-04-13T14:00:00Z").toISOString(),
    activatedBy: "operator-1",
    reason: "Performance investigation",
    isActive: true,
    overrides: { "example.perf.tracing": true },
  };

  const parsed = overrideSessionSchema.parse(input);
  expect(parsed.id).toBe("rt-session-1");
  expect(parsed.activatedBy).toBe("operator-1");
  expect(parsed.isActive).toBe(true);
  expect(parsed.overrides).toEqual({ "example.perf.tracing": true });
});

test("SessionActivationRequest round-trip: construct, validate, check fields", () => {
  const input = {
    reason: "Escalation #1234",
    durationMs: 3600000,
    elevatedAuth: { token: "secure-token", method: "hardware-key" },
  };

  const parsed = sessionActivationRequestSchema.parse(input);
  expect(parsed.reason).toBe("Escalation #1234");
  expect(parsed.durationMs).toBe(3600000);
  expect(parsed.elevatedAuth?.token).toBe("secure-token");
  expect(parsed.elevatedAuth?.method).toBe("hardware-key");
});

test("SessionDeactivationResult round-trip: construct, validate, check fields", () => {
  const input = {
    sessionId: "rt-session-1",
    deactivatedAt: "2026-04-13T14:00:00Z",
    overridesCleared: 12,
    auditRecorded: true,
  };

  const parsed = sessionDeactivationResultSchema.parse(input);
  expect(parsed.sessionId).toBe("rt-session-1");
  expect(parsed.overridesCleared).toBe(12);
  expect(parsed.auditRecorded).toBe(true);
});

test("PropertySessionMode round-trip: parse and verify identity", () => {
  for (const mode of ["allowed", "restricted", "blocked"]) {
    const parsed = propertySessionModeSchema.parse(mode);
    expect(parsed).toBe(mode);
  }
});
