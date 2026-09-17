import { vi } from "vitest";
import { createScopeManager } from "../../src/core/scope-manager.ts";
import { scopeContextId } from "../../src/core/scope-inventory.ts";
import { initialized, record } from "../validated-fixtures.mjs";

const path = (value, scopeId = "tenant") => [{ scopeId, value }];
async function fixture(values, active = false) {
  const f = await initialized({
    records: [record("app", { type: "object", properties: { n: { type: "number" } }, additionalProperties: false })],
    scopes: [{ id: "tenant", label: "Tenant" }],
    contexts: values.map((value) => ({ scopePath: path(value), state: active ? "active" : "retired" })),
    scoped: Object.fromEntries(values.map((value) => [`tenant:${value}`, { app: { n: 1 } }])),
  });
  return { ...f, manager: createScopeManager({ configService: f.service }) };
}

describe("ScopeManager", () => {
  test("provision activates an explicitly prepared context", async () => {
    const f = await fixture(["acme"]);
    try {
      const result = await f.manager.provision({ scopeId: "tenant", value: "acme", actor: "admin" });
      expect(result.success).toBe(true);
      expect(result.scopePath).toEqual(path("acme"));
      expect(f.manager.listScopeValues("tenant")).toEqual(["acme"]);
    } finally { await f.service.close(); }
  });

  test("deprovision retires without deleting scope data", async () => {
    const f = await fixture(["old-co"], true);
    const tenant = f.providers.find((provider) => provider.layer === "tenant");
    try {
      const before = await tenant.loadLayer("tenant:old-co");
      expect((await f.manager.deprovision({ scopePath: path("old-co"), actor: "admin" })).success).toBe(true);
      expect(f.manager.listScopeValues("tenant")).toEqual([]);
      expect(await tenant.loadLayer("tenant:old-co")).toEqual(before);
    } finally { await f.service.close(); }
  });

  test("listScopeValues returns only active values", async () => {
    const f = await fixture(["alpha", "beta"], true);
    try { expect(f.manager.listScopeValues("tenant").sort()).toEqual(["alpha", "beta"]); }
    finally { await f.service.close(); }
  });

  test("listScopes derives definitions from the compiled layout", async () => {
    const f = await initialized({ scopes: [{ id: "tenant", label: "Tenant" }, { id: "site", label: "Site" }] });
    try {
      const manager = createScopeManager({ configService: f.service });
      expect(manager.listScopes()).toEqual([{ id: "tenant", label: "Tenant" }, { id: "site", label: "Site" }]);
    } finally { await f.service.close(); }
  });

  test("idempotent provision does not advance inventory or provider revisions", async () => {
    const f = await fixture(["dup"], true);
    try {
      const revision = f.service.revision;
      const before = await f.platform.load();
      const result = await f.manager.provision({ scopePath: path("dup"), actor: "admin" });
      expect(result.success).toBe(true);
      expect(result.revision).toBe(revision);
      expect(await f.platform.load()).toEqual(before);
    } finally { await f.service.close(); }
  });

  test("provision commits canonical inventory, never a tenant marker or public delta", async () => {
    const f = await fixture(["acme"]);
    const tenant = f.providers.find((provider) => provider.layer === "tenant");
    const writes = vi.spyOn(tenant, "writeLayer");
    const events = [];
    f.service.onDelta((event) => events.push(event));
    try {
      expect((await f.manager.provision({ scopePath: path("acme"), actor: "admin" })).success).toBe(true);
      const state = (await f.platform.load()).entries._weaver.scopeInventory;
      expect(state.revision).toBe("1");
      expect(state.contexts[scopeContextId(path("acme"))].state).toBe("active");
      expect(writes).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    } finally { writes.mockRestore(); await f.service.close(); }
  });
});
