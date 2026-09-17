import assert from "node:assert/strict";
import { test } from "node:test";
import { createRestAdapter } from "../src/transport/rest-adapter.ts";
import { createWeaverScompService } from "../src/transport/scomp-service.ts";
import { createSSEAdapter } from "../src/transport/sse-adapter.ts";
import { SSEClientLifecycle } from "../src/transport/sse-client-lifecycle.ts";
import { suspendControlApplication } from "../src/core/config-service-internal.ts";
import { subscribeConfigServiceLifecycle } from "../src/core/config-service-lifecycle.ts";
import {
  beginPending,
  createExclusiveMaintenanceFixture,
  finishPending,
  reopen,
} from "./exclusive-maintenance-fixture.mjs";

const route = (name) => `weaver-config-v1.${name}`;
const request = { params: {}, query: {}, headers: {} };

function scomp(fixture, overrides = {}) {
  const definition = createWeaverScompService({
    configService: fixture.service,
    schemaRegistry: fixture.registry,
    scopeManager: fixture.scopes,
    ...overrides,
  });
  return (name, input = {}) => definition.router[route(name)].handler(input);
}

async function maintenanceFixture(phase) {
  const fixture = await createExclusiveMaintenanceFixture();
  const pending = await beginPending(fixture);
  if (phase === "active") await finishPending(pending);
  const revision = fixture.host.authority.revision();
  const counters = counterState(fixture.counters);
  return { fixture, pending, revision, counters };
}

test("SSE B closes active and pending creation at the marker and stops checkpoints", async (t) => {
  const fixture = await createExclusiveMaintenanceFixture();
  const adapter = createSSEAdapter({ configService: fixture.service });
  const client = await adapter.createClient();
  t.mock.timers.enable({ apis: ["setInterval"] });
  adapter.startCheckpointTimer(10);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const blocker = fixture.host.coordinator.runApplication(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const creation = adapter.createClient();
  const fence = suspendControlApplication(fixture.service);
  await assert.rejects(creation, { code: "MAINTENANCE" });
  assert.equal(adapter.clientCount, 0);
  const count = client.messages.length;
  t.mock.timers.tick(100);
  assert.equal(client.messages.length, count);
  release.resolve();
  await Promise.all([blocker, fence]);
  t.mock.timers.reset();
  await fixture.close();
});

for (const phase of ["pending", "active"]) {
  test(`SSE ${phase === "pending" ? "P" : "A"} rejects with zero clients`, async () => {
    const { fixture, pending } = await maintenanceFixture(phase);
    const adapter = createSSEAdapter({ configService: fixture.service });
    await assert.rejects(adapter.createClient(), { code: "MAINTENANCE" });
    assert.equal(adapter.clientCount, 0);
    if (phase === "pending") await finishPending(pending);
    await fixture.close();
  });
}

test("SSE resume keeps old clients dead and admits only fresh snapshots and deltas", async () => {
  const fixture = await createExclusiveMaintenanceFixture();
  const adapter = createSSEAdapter({ configService: fixture.service });
  const oldClient = await adapter.createClient();
  await fixture.host.maintenance.enter();
  assert.equal(adapter.clientCount, 0);
  assert.deepEqual(oldClient.messages, []);
  reopen(fixture);
  const freshClient = await adapter.createClient();
  assert.equal(adapter.clientCount, 1);
  assert.equal(freshClient.messages.length, 1);
  await fixture.service.set("platform", "svc.keep", false);
  assert.equal(freshClient.messages.length, 3);
  assert.deepEqual(oldClient.messages, []);
  adapter.closeAll();
  await fixture.host.maintenance.enter();
  reopen(fixture);
  await assert.rejects(adapter.createClient(), /SSE adapter is closed/);
  await fixture.close();
});

test("SSE resume never revives a pending pre-fence creation", async () => {
  const fixture = await createExclusiveMaintenanceFixture();
  const adapter = createSSEAdapter({ configService: fixture.service });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const blocker = fixture.host.coordinator.runApplication(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const oldCreation = adapter.createClient();
  const fence = fixture.host.maintenance.enter();
  await assert.rejects(oldCreation, { code: "MAINTENANCE" });
  release.resolve();
  await Promise.all([blocker, fence]);
  reopen(fixture);
  const freshClient = await adapter.createClient();
  assert.equal(freshClient.messages.length, 1);
  assert.equal(adapter.clientCount, 1);
  adapter.closeAll();
  await fixture.close();
});

test("SSE resume restarts exactly one configured checkpoint interval", async (t) => {
  const fixture = await createExclusiveMaintenanceFixture();
  const adapter = createSSEAdapter({ configService: fixture.service });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const oldClient = await adapter.createClient();
  adapter.startCheckpointTimer(10);
  t.mock.timers.tick(10);
  assert.equal(oldClient.messages.length, 2);
  await fixture.host.maintenance.enter();
  t.mock.timers.tick(20);
  assert.deepEqual(oldClient.messages, []);
  reopen(fixture);
  reopen(fixture);
  const freshClient = await adapter.createClient();
  t.mock.timers.tick(10);
  assert.equal(freshClient.messages.length, 2);
  t.mock.timers.tick(10);
  assert.equal(freshClient.messages.length, 3);
  adapter.closeAll();
  t.mock.timers.reset();
  await fixture.close();
});

test("SSE lifecycle ignores stale generations and disposal is permanent", async () => {
  const lifecycle = new SSEClientLifecycle();
  lifecycle.initialize({ generation: 0, state: "open" }, new Error("suspend"));
  lifecycle.transition({ generation: 2, state: "suspended" }, new Error("suspend"));
  lifecycle.transition({ generation: 2, state: "open" }, new Error("suspend"));
  lifecycle.transition({ generation: 1, state: "suspended" }, new Error("stale"));
  const client = lifecycleClient(lifecycle);
  lifecycle.add(client);
  assert.equal(lifecycle.clientCount, 1);
  lifecycle.dispose(new Error("disposed"));
  lifecycle.transition({ generation: 3, state: "open" }, new Error("suspend"));
  assert.throws(() => lifecycle.beginCreation(), /disposed/);
  assert.equal(lifecycle.clientCount, 0);
});

test("resume lifecycle notifies all listeners and fails closed on listener failure", async () => {
  const fixture = await createExclusiveMaintenanceFixture();
  let observed = 0;
  subscribeConfigServiceLifecycle(fixture.service, (event) => {
    if (event.state === "open") throw new Error("listener failed");
  });
  subscribeConfigServiceLifecycle(fixture.service, (event) => {
    if (event.state === "open") observed++;
  });
  await fixture.host.maintenance.enter();
  assert.throws(() => reopen(fixture), { code: "MAINTENANCE" });
  assert.equal(observed, 1);
  assert.equal(fixture.host.coordinator.state(), "closed");
  const lifecycle = subscribeConfigServiceLifecycle(fixture.service, () => {});
  assert.equal(lifecycle.current.state, "suspended");
  await assert.rejects(fixture.service.get("svc.keep"), {
    code: "SERVER_DEGRADED",
  });
  await fixture.close();
});

function lifecycleClient(lifecycle) {
  let client;
  client = {
    id: "internal",
    options: {},
    messages: [],
    send() {},
    close() {
      lifecycle.delete(client);
    },
  };
  return client;
}

const restCases = [
  ["ordinary", "GET", "/v1/config"],
  ["registered/schema", "GET", "/v1/registered/effective/svc"],
  ["scope", "GET", "/v1/scopes"],
];

for (const phase of ["pending", "active"]) {
  for (const [family, method, path] of restCases) {
    test(`REST ${family} ${phase === "pending" ? "P" : "A"} is 503 MAINTENANCE`, async () => {
      const { fixture, pending, revision, counters } =
        await maintenanceFixture(phase);
      const adapter = createRestAdapter({
        configService: fixture.service,
        schemaRegistry: fixture.registry,
        scopeManager: fixture.scopes,
      });
      const response = await adapter.handleRequest(method, path, request);
      assert.equal(response.status, 503);
      assert.equal(response.body.error.code, "MAINTENANCE");
      assert.equal(fixture.host.authority.revision(), revision);
      assert.deepEqual(counterState(fixture.counters), counters);
      if (phase === "pending") await finishPending(pending);
      await fixture.close();
    });
  }
}

test("SCOMP B yields only pre-marker deltas and then ends", async () => {
  const fixture = await createExclusiveMaintenanceFixture();
  const iterator = scomp(fixture)("subscribe")[Symbol.asyncIterator]();
  const first = iterator.next();
  await fixture.service.set("platform", "svc.keep", false);
  assert.equal((await first).done, false);
  assert.equal((await iterator.next()).done, false);
  const ending = iterator.next();
  const fence = fixture.host.maintenance.enter();
  assert.deepEqual(await ending, { done: true, value: undefined });
  await fence;
  await iterator.return();
  await fixture.close();
});

function counterState(counters) {
  return {
    load: counters.load,
    commit: counters.commit,
    refresh: counters.refresh,
    flush: counters.flush,
    watch: counters.watch,
    watchDispose: counters.watchDispose,
    order: [...counters.order],
  };
}

for (const phase of ["pending", "active"]) {
  test(`SCOMP ${phase === "pending" ? "P" : "A"} installs zero feed listeners`, async () => {
    const { fixture, pending } = await maintenanceFixture(phase);
    const before = fixture.counters.listener;
    const iterator = scomp(fixture)("subscribe")[Symbol.asyncIterator]();
    await assert.rejects(iterator.next(), { code: "MAINTENANCE" });
    assert.equal(fixture.counters.listener, before);
    if (phase === "pending") await finishPending(pending);
    await fixture.close();
  });
}

test("SCOMP listener install failure and pending race clean lifecycle exactly once", async () => {
  for (const mode of ["throw", "pending"]) {
    let maintenance;
    let maintenanceStops = 0;
    let deltaStops = 0;
    const service = {
      onDelta() {
        if (mode === "throw") throw new Error("install failed");
        maintenance();
        return () => deltaStops++;
      },
    };
    const call = scomp(
      { service, registry: {}, scopes: {} },
      {
        onMaintenance(listener) {
          maintenance = listener;
          return () => maintenanceStops++;
        },
      },
    );
    const iterator = call("subscribe")[Symbol.asyncIterator]();
    if (mode === "throw") await assert.rejects(iterator.next(), /install failed/);
    else assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    assert.equal(maintenanceStops, 1);
    assert.equal(deltaStops, mode === "pending" ? 1 : 0);
  }
});
