import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createScopeManager } from "../src/core/scope-manager.ts";
import { createSchemaRegistry } from "../src/core/schema-registry.ts";
import { scopeContextId } from "../src/core/scope-inventory.ts";
import { createRestAdapter } from "../src/transport/rest-adapter.ts";
import { createWeaverScompService } from "../src/transport/scomp-service.ts";
import { createTestService } from "./setup-service.ts";
import { initialized, record } from "./validated-fixtures.mjs";

const schema = { type: "object", properties: { n: { type: "number" } }, additionalProperties: false };
const path = [{ scopeId: "tenant", value: "retired" }];

async function inspectEverywhere(service) {
  const core = await service.inspect("svc.n");
  const rest = createRestAdapter({ configService: service });
  const response = await rest.handleRequest("GET", "/v1/config/svc/n", { params: {}, headers: {}, query: { inspect: "" } });
  assert.equal(response.status, 200);
  const scomp = createWeaverScompService({ configService: service,
    scopeManager: createScopeManager({ configService: service }), schemaRegistry: createSchemaRegistry({ configService: service }) });
  const rpc = await scomp.router["weaver-config-v1.inspect"].handler({ key: "svc.n" });
  assert.deepEqual(response.body.data, core);
  assert.deepEqual(rpc, core);
  return core;
}

for (const dynamic of [false, true]) for (const initiallyRetired of [false, true]) {
  test(`P3: inspection hides ${dynamic ? "dynamic" : "static scoped"} data, initially retired=${initiallyRetired}`, async (t) => {
    const base = createInMemoryStorageProvider({ id: "base", layer: "platform", initialEntries: { svc: { n: 1 } } });
    const scoped = createInMemoryStorageProvider({ id: "tenant-data", layer: dynamic ? "tenant" : "tenant:retired",
      initialEntries: { svc: { n: dynamic ? 333333 : 987654 } } });
    if (dynamic) {
      await scoped.loadLayer("tenant:retired");
      assert.equal((await scoped.writeLayer("tenant:retired", "svc.n", 987654)).success, true);
    }
    const inventory = { version: 1, revision: "0", contexts: {
      [scopeContextId(path)]: { scopePath: path, state: initiallyRetired ? "retired" : "active" },
    } };
    const service = await createTestService({ providers: [base, scoped], environment: "dev", scopeInventory: inventory }, { svc: schema }, [path]);
    t.after(() => service.close());
    if (!initiallyRetired) {
      assert.equal((await inspectEverywhere(service)).effectiveValue, 987654);
      assert.equal((await createScopeManager({ configService: service }).deprovision({ scopePath: path, actor: "admin" })).success, true);
    }
    const revision = service.revision;
    const inspection = await inspectEverywhere(service);
    assert.deepEqual(inspection, { key: "svc.n", effectiveValue: 1, effectiveLayer: "platform", layerValues: { platform: 1 } });
    await assert.rejects(service.get("svc.n", { scopePath: path }), { code: "SCOPE_NOT_FOUND" });
    assert.equal((await scoped.loadLayer("tenant:retired")).entries.svc.n, 987654);
    const object = await service.inspect("svc");
    object.effectiveValue.n = "must-not-mutate-live-data";
    assert.equal(await service.get("svc.n"), 1);
    assert.equal(service.revision, revision);
  });
}

test("P3: shared child inspection follows active full contexts and retains retired physical data", async (t) => {
  const a = [{ scopeId: "tenant", value: "a" }];
  const b = [{ scopeId: "tenant", value: "b" }];
  const ae = [...a, { scopeId: "region", value: "eu" }];
  const be = [...b, { scopeId: "region", value: "eu" }];
  const f = await initialized({ data: { svc: { n: 1 } }, records: [record("svc", schema)],
    scopes: [{ id: "tenant", label: "Tenant" }, { id: "region", label: "Region", parentScopeId: "tenant" }],
    contexts: [a, b, ae, be].map((scopePath) => ({ scopePath, state: "active" })),
    scoped: { "tenant:a": { svc: { n: 111111 } }, "tenant:b": { svc: { n: 222222 } }, "region:eu": { svc: { n: 333333 } } },
  });
  t.after(() => f.service.close());
  const manager = createScopeManager({ configService: f.service });
  for (const scopePath of [ae, a]) assert.equal((await manager.deprovision({ scopePath, actor: "admin" })).success, true);
  let inspection = await inspectEverywhere(f.service);
  assert.equal(inspection.layerValues["tenant:a"], undefined);
  assert.equal(inspection.layerValues["region:eu"], 333333);
  assert.equal(inspection.effectiveLayer, "region:eu");
  assert.equal((await manager.deprovision({ scopePath: be, actor: "admin" })).success, true);
  inspection = await inspectEverywhere(f.service);
  assert.equal(inspection.layerValues["region:eu"], undefined);
  assert.equal(inspection.effectiveValue, 222222);
  assert.equal(inspection.effectiveLayer, "tenant:b");
  assert.equal((await f.providers[2].loadLayer("region:eu")).entries.svc.n, 333333);
  const rest = createRestAdapter({ configService: f.service });
  for (const [scope, status] of [["tenant:a/region:eu", 404], ["tenant:unknown", 404], ["", 400]]) {
    const response = await rest.handleRequest("GET", "/v1/config/svc/n", { params: {}, headers: {}, query: { inspect: "", scope } });
    assert.equal(response.status, status);
  }
});
