import { vi } from "vitest";
import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";
import { normalizeBatchEntries } from "../../src/core/schema-write-boundary.ts";
import { evaluateEffectiveCandidate } from "../../src/core/schema-effective-candidate.ts";
import { initialized, record } from "../validated-fixtures.mjs";

const schema = {
  type: "object", required: ["mode"], additionalProperties: false,
  properties: { mode: { type: "string", enum: ["prod", "test"] }, limit: { type: "number" },
    nested: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false },
  },
};
const path = (value) => [{ scopeId: "tenant", value }];

async function fixture(options = {}) {
  const f = await initialized({ records: [record("billing", schema)], data: { billing: { mode: "prod", limit: 1 } }, ...options });
  return { ...f, registry: createSchemaRegistry({ configService: f.service }) };
}
async function scoped() {
  return fixture({ scopes: [{ id: "tenant", label: "Tenant" }],
    contexts: ["one", "two"].map((value) => ({ scopePath: path(value), state: "active" })),
    scoped: { "tenant:one": { billing: { limit: 2 } }, "tenant:two": { billing: { limit: 3 } } },
  });
}
async function fragments() {
  const parent = record("billing", schema);
  parent.request.fragmentSlots = [{ slotPath: "/plugins", accepts: "object" }];
  const child = { version: 1, kind: "fragment", request: { serviceId: "billing", environment: "dev", owner: parent.request.owner,
    providerId: "plugin", slotPath: "/plugins", schema: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false } }, audit: { actor: "fixture" } };
  return fixture({ records: [parent, child], data: { billing: { mode: "prod", plugins: { plugin: { enabled: true } } } } });
}
async function denied(f, operation) {
  const before = (await f.platform.load()).entries;
  const revision = f.service.revision;
  const result = await operation();
  expect(result.success).toBe(false);
  expect((await f.platform.load()).entries).toEqual(before);
  expect(f.service.revision).toBe(revision);
}

describe("schema-registered canonical pipeline", () => {
  test("normal direct and batch writes validate before provider mutation", async () => {
    const f = await fixture();
    try {
      await denied(f, () => f.service.set("platform", "billing.mode", "qa"));
      await denied(f, () => f.service.setMany("platform", { "unregistered.safe": true, "billing.limit": "many" }));
    } finally { await f.service.close(); }
  });

  test("caller metadata cannot select a different write environment", async () => {
    const f = await fixture();
    try { await denied(f, () => f.service.set("platform", "billing.mode", "qa", { environment: "other" })); }
    finally { await f.service.close(); }
  });

  test("batches reject semantic duplicate paths before IO", async () => {
    const f = await fixture();
    const writes = vi.spyOn(f.platform.authority, "commitLayer");
    try {
      await denied(f, () => f.service.setMany("platform", { "billing.limit": 2, "billing[limit]": 3 }));
      expect(writes).not.toHaveBeenCalled();
    } finally { writes.mockRestore(); await f.service.close(); }
  });

  test("batches reject ancestor and descendant paths in either order", async () => {
    const f = await fixture();
    try {
      for (const pairs of [[ ["billing", {}], ["billing.mode", "test"] ], [ ["billing.mode", "test"], ["billing", {}] ]])
        await denied(f, () => f.service.setMany("platform", Object.fromEntries(pairs)));
    } finally { await f.service.close(); }
  });

  test("batch overlap preflight handles large sibling cardinality", () => {
    expect(normalizeBatchEntries(Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`billing.key${i}`, i]))).success).toBe(true);
  });

  test("batch overlap diagnostics are independent of input order", () => {
    const pairs = [["a", {}], ["a.b", 1], ["z.x", 2], ["z", {}]];
    expect(normalizeBatchEntries(Object.fromEntries(pairs))).toEqual(normalizeBatchEntries(Object.fromEntries([...pairs].reverse())));
  });

  test("deep every-prefix batches reject before revision or provider work", async () => {
    const f = await fixture();
    const writes = vi.spyOn(f.platform.authority, "commitLayer");
    try {
      const entries = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [Array.from({ length: i + 1 }, () => "chain").join("."), i]));
      await denied(f, () => f.service.setMany("platform", entries, { expectedRevision: "stale" }));
      expect(writes).not.toHaveBeenCalled();
    } finally { writes.mockRestore(); await f.service.close(); }
  });

  test("another registry handle cannot weaken enforcement without a current revision", async () => {
    const f = await fixture();
    try {
      const second = createSchemaRegistry({ configService: f.service });
      expect((await second.register(record("billing", { type: "object", additionalProperties: true }).request)).error.code).toBe("REVISION_CONFLICT");
      await denied(f, () => f.service.set("platform", "billing.mode", "qa"));
    } finally { await f.service.close(); }
  });

  test("valid combined batch candidates retain effective completeness", async () => {
    const f = await fixture();
    try {
      expect((await f.service.setMany("platform", { "billing.limit": 2, "billing.nested": { enabled: true } })).success).toBe(true);
      expect(await f.service.get("billing")).toEqual({ mode: "prod", limit: 2, nested: { enabled: true } });
    } finally { await f.service.close(); }
  });

  test("provider failures remain fail-fast after schema preflight", async () => {
    const f = await fixture();
    const fault = vi.spyOn(f.platform.authority, "commitLayer").mockResolvedValue({ success: false, error: { code: "INTERNAL_ERROR", message: "injected" } });
    try {
      await denied(f, () => f.service.setMany("platform", { "billing.limit": 2, "billing.mode": "test" }));
      expect(fault).toHaveBeenCalledTimes(1);
    } finally { fault.mockRestore(); await f.service.close(); }
  });

  test("removal rejects invalid base but permits a valid scoped fallback", async () => {
    const f = await scoped();
    try {
      await denied(f, () => f.service.remove("platform", "billing.mode"));
      expect((await f.service.remove("tenant:one", "billing.limit")).success).toBe(true);
      expect(await f.service.get("billing.limit", { scopePath: path("one") })).toBe(1);
    } finally { await f.service.close(); }
  });

  test("ancestor writes validate service roots and fragment lookups use the deepest anchor", async () => {
    const f = await fragments();
    try {
      expect((await f.registry.resolveAnchor("/billing/plugins/plugin/enabled", "dev")).kind).toBe("fragment");
      await denied(f, () => f.service.set("platform", "billing", { mode: "prod", plugins: { rogue: {} } }));
    } finally { await f.service.close(); }
  });

  test("registered object writes allow sparse scope layers, never incomplete effective base", async () => {
    const f = await scoped();
    try {
      await denied(f, () => f.service.setRegisteredObject("platform", "/billing", { limit: 10 }, { schemaRegistry: f.registry }));
      expect((await f.service.setRegisteredObject("tenant:one", "/billing", { limit: 10 }, { schemaRegistry: f.registry })).success).toBe(true);
      expect(await f.service.get("billing", { scopePath: path("one") })).toEqual({ mode: "prod", limit: 10 });
    } finally { await f.service.close(); }
  });

  test("fragment object writes retain parent and slot constraints", async () => {
    const f = await fragments();
    try {
      expect((await f.service.setRegisteredObject("platform", "/billing/plugins/plugin", { enabled: false }, { schemaRegistry: f.registry })).success).toBe(true);
      await denied(f, () => f.service.setRegisteredObject("platform", "/billing/plugins/plugin", { rogue: true }, { schemaRegistry: f.registry }));
    } finally { await f.service.close(); }
  });

  test("property patches persist the resulting anchor object", async () => {
    const f = await fixture();
    try {
      expect((await f.service.patchRegisteredPath("platform", "/billing/nested/enabled", true, { schemaRegistry: f.registry })).success).toBe(true);
      expect((await f.platform.load()).entries.billing).toEqual({ mode: "prod", limit: 1, nested: { enabled: true } });
    } finally { await f.service.close(); }
  });

  test("invalid type, property, enum and nested patches are rejected", async () => {
    const f = await fixture();
    try {
      for (const [target, value] of [["limit", "many"], ["rogue", true], ["mode", "qa"], ["nested", 1]])
        await denied(f, () => f.service.patchRegisteredPath("platform", `/billing/${target}`, value, { schemaRegistry: f.registry }));
    } finally { await f.service.close(); }
  });

  test("prototype-pollution segments are rejected without prototype mutation", async () => {
    const f = await fixture();
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    try {
      for (const segment of ["__proto__", "constructor", "prototype"])
        await denied(f, () => f.service.patchRegisteredPath("platform", `/billing/${segment}/polluted`, true, { schemaRegistry: f.registry }));
      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
    } finally { await f.service.close(); }
  });

  test("effective completeness is enforced before a replacement becomes active", async () => {
    const f = await fixture();
    try {
      await denied(f, () => f.service.set("platform", "billing", {}));
      expect((await f.service.validateRegisteredEffective("/billing", { schemaRegistry: f.registry })).valid).toBe(true);
    } finally { await f.service.close(); }
  });

  test("rejected activation preserves valid intersecting and unrelated reads", async () => {
    const f = await fixture({ records: [record("billing", schema), record("public", { type: "object", additionalProperties: true })], data: { billing: { mode: "prod" }, public: { ready: true } } });
    try {
      const candidate = record("billing", { ...schema, required: ["mode", "limit"] }).request;
      expect((await f.registry.register(candidate, { expectedRevision: f.service.revision })).success).toBe(false);
      expect(await f.service.get("billing.mode")).toBe("prod");
      expect(await f.service.get("public.ready")).toBe(true);
    } finally { await f.service.close(); }
  });

  test("effective reads validate defaults, mounts, and scope merges", async () => {
    const f = await fixture({ records: [record("billing", schema), record("shared", { type: "object", additionalProperties: true })],
      data: { billing: { mode: { _weaver: "mount", source: "shared.mode" } }, shared: { mode: "prod" } },
      scopes: [{ id: "tenant", label: "Tenant" }], contexts: [{ scopePath: path("one"), state: "active" }], scoped: { "tenant:one": { shared: { mode: "test" } } },
    });
    try {
      expect(await f.service.get("billing.mode")).toBe("prod");
      expect(await f.service.get("billing.mode", { scopePath: path("one") })).toBe("test");
    } finally { await f.service.close(); }
  });

  test("invalid cold scope data refuses startup rather than dropping a scope", async () => {
    const f = await scoped();
    await f.service.close();
    const tenant = f.providers.find((provider) => provider.layer === "tenant");
    await tenant.writeLayer("tenant:two", "billing.mode", "qa");
    await expect(createWeaverConfigService({ providers: f.providers, environment: "dev" })).rejects.toThrow();
  });

  test("scope snapshots are complete and isolated", async () => {
    const f = await scoped();
    try {
      const snapshot = await f.service.resolveAll();
      expect(snapshot.entries.billing.limit).toBe(1);
      expect(snapshot.scopes["tenant:one"].billing).toEqual({ mode: "prod", limit: 2 });
      expect(snapshot.scopes["tenant:two"].billing).toEqual({ mode: "prod", limit: 3 });
      snapshot.scopes["tenant:one"].billing.limit = 999;
      expect(await f.service.get("billing.limit", { scopePath: path("two") })).toBe(3);
    } finally { await f.service.close(); }
  });

  test("mounted object arrays reject invalid source updates and retain valid projections", async () => {
    const rows = { type: "array", items: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false } };
    const f = await fixture({ records: [record("billing", { ...schema, properties: { ...schema.properties, rows } }), record("shared", { type: "object", additionalProperties: true })],
      data: { billing: { mode: "prod", rows: { _weaver: "mount", source: "shared.rows" } }, shared: { rows: [{ enabled: true }] } },
    });
    try {
      await denied(f, () => f.service.set("platform", "shared.rows", [{ enabled: "bad" }]));
      expect((await f.service.set("platform", "shared.rows", [{ enabled: false }])).success).toBe(true);
      expect(await f.service.get("billing.rows")).toEqual([{ enabled: false }]);
    } finally { await f.service.close(); }
  });

  test("malformed optional mounts never appear in public snapshots or projections", async () => {
    const f = await fixture({ records: [record("billing", { type: "object", additionalProperties: true })], data: { billing: { valid: 1, hidden: { _weaver: "mount", source: 42 } } } });
    try { expect((await f.service.resolveAll()).entries).toEqual({ billing: { valid: 1 } }); }
    finally { await f.service.close(); }
  });

  test("overlapping parent/fragment enforcement rejects rogue slot children", async () => {
    const f = await fragments();
    try { await denied(f, () => f.service.setMany("platform", { "billing.plugins.rogue": {} })); }
    finally { await f.service.close(); }
  });

  test("effective candidate failures select canonical anchor order", () => {
    const anchor = (name) => ({ kind: "service", path: `/${name}`, schema, environment: "dev", metadata: {} });
    expect(evaluateEffectiveCandidate([anchor("zeta"), anchor("alpha")], { alpha: { mode: "qa" }, zeta: { mode: "qa" } }).anchorPath).toBe("/alpha");
  });

  test("object reads and projections use the same recursively resolved values", async () => {
    const f = await fixture({ records: [record("billing", schema), record("shared", { type: "object", additionalProperties: true })],
      data: { billing: { mode: "prod", nested: { _weaver: "mount", source: "shared.nested" } }, shared: { nested: { enabled: true } } },
    });
    const events = [];
    f.service.onDelta((event) => events.push(event));
    try {
      await f.service.set("platform", "shared.nested", { enabled: false });
      expect(events.find((event) => event.key === "billing").value).toEqual(await f.service.get("billing"));
      expect(JSON.stringify(events)).not.toContain("_weaver");
    } finally { await f.service.close(); }
  });

  test("overlapping anchors project one topmost service root", async () => {
    const f = await fragments();
    const events = [];
    f.service.onDelta((event) => events.push(event));
    try {
      await f.service.set("platform", "billing.plugins.plugin.enabled", false);
      expect(events.map((event) => event.key)).toEqual(["billing"]);
      expect(events[0].value).toEqual(await f.service.get("billing"));
    } finally { await f.service.close(); }
  });

  test("a valid fragment cannot authorize an invalid parent mutation", async () => {
    const f = await fragments();
    const events = [];
    f.service.onDelta((event) => events.push(event));
    try {
      await denied(f, () => f.service.remove("platform", "billing.mode"));
      expect(events).toEqual([]);
    } finally { await f.service.close(); }
  });

  test("scoped mutations publish only their affected full contexts", async () => {
    const f = await scoped();
    const events = [];
    f.service.onDelta((event) => events.push(event));
    try {
      await f.service.set("tenant:one", "billing.limit", 4);
      expect(events.map((event) => event.layer)).toEqual(["tenant:one"]);
      expect(events[0].value).toEqual({ mode: "prod", limit: 4 });
    } finally { await f.service.close(); }
  });

  test("protected and unregistered public writes are rejected", async () => {
    const f = await fixture();
    try {
      for (const key of ["_weaver", "_weaver.catalog.registrations", "unregistered.value"])
        await denied(f, () => f.service.set("platform", key, {}, { internal: true }));
    } finally { await f.service.close(); }
  });

  test("publication is ordered and throwing listeners cannot reverse commits", async () => {
    const f = await fixture();
    const events = [];
    f.service.onDelta((event) => { events.push(event); throw new Error("observer"); });
    try {
      const results = await Promise.all([f.service.set("platform", "billing.mode", "test"), f.service.set("platform", "billing.mode", "prod")]);
      expect(results.every((result) => result.success)).toBe(true);
      expect(events.map((event) => event.value.mode)).toEqual(["test", "prod"]);
    } finally { await f.service.close(); }
  });

  test("invalid persisted anchors are never admitted to ordinary patch APIs", async () => {
    const f = await fixture();
    await f.service.close();
    await f.platform.write("billing", "corrupt");
    await expect(createWeaverConfigService({ providers: f.providers, environment: "dev" })).rejects.toThrow();
  });
});
