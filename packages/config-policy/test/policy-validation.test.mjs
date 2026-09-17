import { validateChangePolicies } from "../dist/index.js";

function entry(key, schema) {
  return [key, schema];
}

test("security-sensitive key with direct-allowed produces error", () => {
  const schemas = new Map([
    entry("app.auth.apiKey", { type: "string", "x-weaver": { changePolicy: "direct-allowed" } }),
  ]);
  const violations = validateChangePolicies(schemas);
  expect(violations.length).toBe(1);
  expect(violations[0].severity).toBe("error");
  expect(violations[0].key).toBe("app.auth.apiKey");
  expect(violations[0].suggestedPolicy).toBe("full-pipeline");
});

test("security-sensitive key with full-pipeline produces no violation", () => {
  const schemas = new Map([
    entry("app.auth.password", { type: "string", "x-weaver": { changePolicy: "full-pipeline" } }),
  ]);
  const violations = validateChangePolicies(schemas);
  expect(violations.length).toBe(0);
});

test("internal visibility with direct-allowed produces warning", () => {
  const schemas = new Map([
    entry("app.core.debugLevel", {
      type: "string",
      "x-weaver": {
        changePolicy: "direct-allowed",
        visibility: "internal",
      },
    }),
  ]);
  const violations = validateChangePolicies(schemas);
  expect(violations.length).toBe(1);
  expect(violations[0].severity).toBe("warning");
  expect(violations[0].key).toBe("app.core.debugLevel");
  expect(violations[0].suggestedPolicy).toBe("staging-gate");
});

test("restart-required with direct-allowed produces warning", () => {
  const schemas = new Map([
    entry("app.server.port", {
      type: "number",
      "x-weaver": {
        changePolicy: "direct-allowed",
        reloadBehavior: "restart-required",
      },
    }),
  ]);
  const violations = validateChangePolicies(schemas);
  expect(violations.length).toBe(1);
  expect(violations[0].severity).toBe("warning");
  expect(violations[0].key).toBe("app.server.port");
  expect(violations[0].suggestedPolicy).toBe("staging-gate");
});

test("normal key with direct-allowed produces no violation", () => {
  const schemas = new Map([
    entry("app.ui.theme", { type: "string", "x-weaver": { changePolicy: "direct-allowed" } }),
  ]);
  const violations = validateChangePolicies(schemas);
  expect(violations.length).toBe(0);
});

test("empty schema map produces no violations", () => {
  const schemas = new Map();
  const violations = validateChangePolicies(schemas);
  expect(violations.length).toBe(0);
});

test("security-sensitive key with staging-gate produces no violation", () => {
  const schemas = new Map([
    entry("app.db.credential", { type: "string", "x-weaver": { changePolicy: "staging-gate" } }),
  ]);
  const violations = validateChangePolicies(schemas);
  expect(violations.length).toBe(0);
});

test("multiple violations from one schema map", () => {
  const schemas = new Map([
    entry("app.auth.secret", { type: "string", "x-weaver": { changePolicy: "direct-allowed" } }),
    entry("app.core.internal", {
      type: "string",
      "x-weaver": {
        changePolicy: "direct-allowed",
        visibility: "internal",
      },
    }),
    entry("app.server.port", {
      type: "number",
      "x-weaver": {
        changePolicy: "direct-allowed",
        reloadBehavior: "restart-required",
      },
    }),
    entry("app.ui.color", { type: "string", "x-weaver": { changePolicy: "direct-allowed" } }),
  ]);
  const violations = validateChangePolicies(schemas);
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");
  expect(errors.length).toBe(1); // secret
  expect(warnings.length).toBe(2); // internal + restart-required
});

test("sensitive + public visibility produces error", () => {
  const schemas = new Map([
    entry("app.db.connectionString", {
      type: "string",
      "x-weaver": { sensitive: true, visibility: "public" },
    }),
  ]);
  const violations = validateChangePolicies(schemas);
  const match = violations.find((v) => v.violation.includes("Sensitive key"));
  expect(match).toBeTruthy();
  expect(match.severity).toBe("error");
});

test("sensitive + admin visibility produces no sensitive-public violation", () => {
  const schemas = new Map([
    entry("app.db.connectionString", {
      type: "string",
      "x-weaver": { sensitive: true, visibility: "admin" },
    }),
  ]);
  const violations = validateChangePolicies(schemas);
  const match = violations.find((v) => v.violation.includes("Sensitive key"));
  expect(match).toBe(undefined);
});

test("sensitive + internal visibility produces no sensitive-public violation", () => {
  const schemas = new Map([
    entry("app.db.connectionString", {
      type: "string",
      "x-weaver": { sensitive: true, visibility: "internal" },
    }),
  ]);
  const violations = validateChangePolicies(schemas);
  const match = violations.find((v) => v.violation.includes("Sensitive key"));
  expect(match).toBe(undefined);
});

test("sensitive + platform visibility produces no sensitive-public violation", () => {
  const schemas = new Map([
    entry("app.db.connectionString", {
      type: "string",
      "x-weaver": { sensitive: true, visibility: "platform" },
    }),
  ]);
  const violations = validateChangePolicies(schemas);
  const match = violations.find((v) => v.violation.includes("Sensitive key"));
  expect(match).toBe(undefined);
});

test("not sensitive + public visibility produces no sensitive-public violation", () => {
  const schemas = new Map([
    entry("app.ui.theme", {
      type: "string",
      "x-weaver": { sensitive: false, visibility: "public" },
    }),
  ]);
  const violations = validateChangePolicies(schemas);
  const match = violations.find((v) => v.violation.includes("Sensitive key"));
  expect(match).toBe(undefined);
});

test("key with no explicit changePolicy defaults to direct-allowed for check", () => {
  const schemas = new Map([
    entry("app.auth.token", { type: "string" }), // no changePolicy → defaults to direct-allowed
  ]);
  const violations = validateChangePolicies(schemas);
  expect(violations.length).toBe(1);
  expect(violations[0].severity).toBe("error");
  expect(violations[0].currentPolicy).toBe("direct-allowed");
});
