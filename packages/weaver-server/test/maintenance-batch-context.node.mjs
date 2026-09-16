import assert from "node:assert/strict";
import { test } from "node:test";
import { createWeaverError } from "@weaver-conf/config-types";
import {
  createApplicationMaintenanceBarrier,
  waitForMaintenanceFence,
} from "../src/core/application-maintenance-barrier.ts";
import { suspendControlApplication } from "../src/core/config-service-internal.ts";
import {
  beginPending,
  createExclusiveMaintenanceFixture,
  finishPending,
  reopen,
} from "./exclusive-maintenance-fixture.mjs";

test("batch lease survives await for nested set-read-set", async (t) => {
  const fixture = await batchFixture(t);
  const commits = fixture.counters.commit;
  const flushes = fixture.counters.flush;
  await fixture.service.batch(async () => {
    await Promise.resolve();
    assert.equal((await fixture.service.set("platform", "svc.keep", true)).success, true);
    assert.equal(await fixture.service.get("svc.keep"), true);
    assert.equal((await fixture.service.set("platform", "svc.keep", false)).success, true);
  });
  assert.equal(fixture.counters.commit, commits + 2);
  assert.equal(fixture.counters.flush, flushes + 1);
});

test("nested batch reuses the outer lease and flushes exactly once", async (t) => {
  const fixture = await batchFixture(t);
  const flushes = fixture.counters.flush;
  await fixture.service.batch(async () => {
    await Promise.resolve();
    await fixture.service.batch(async () => {
      await Promise.resolve();
      assert.equal((await fixture.service.set("platform", "svc.keep", true)).success, true);
    });
  });
  assert.equal(fixture.counters.flush, flushes + 1);
});

test("pending maintenance waits for later nested batch operations", async (t) => {
  const fixture = await batchFixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let deltas = 0;
  fixture.service.onDelta(() => deltas++);
  const batch = fixture.service.batch(async () => {
    entered.resolve();
    await release.promise;
    assert.equal((await fixture.service.set("platform", "svc.keep", true)).success, true);
    assert.equal(await fixture.service.get("svc.keep"), true);
    assert.equal((await fixture.service.set("platform", "svc.keep", false)).success, true);
  });
  await entered.promise;
  const unrelated = fixture.service.set("platform", "svc.keep", true);
  assert.equal((await unrelated).success, true);
  const deltasAtPending = deltas;
  const fence = suspendControlApplication(fixture.service);
  assert.equal(fixture.host.coordinator.state(), "pending");
  assert.equal((await fixture.service.set("platform", "svc.keep", false)).error.code, "MAINTENANCE");
  release.resolve();
  await batch;
  await fence;
  assert.equal(deltas, deltasAtPending);
  assert.equal(fixture.host.coordinator.state(), "active");
});

test("batch fence timeout remains pending on the same fence", async (t) => {
  const fixture = await batchFixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const batch = fixture.service.batch(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const fence = suspendControlApplication(fixture.service);
  assert.equal(suspendControlApplication(fixture.service), fence);
  await assert.rejects(
    waitForMaintenanceFence(fence, {
      schedule: (callback) => setTimeout(callback, 0),
      cancel: (handle) => clearTimeout(handle),
    }),
    { code: "MAINTENANCE" },
  );
  assert.equal(fixture.host.coordinator.state(), "pending");
  release.resolve();
  await Promise.all([batch, fence]);
});

test("pending batch submission rejects before its callback", async (t) => {
  const fixture = await batchFixture(t);
  const pending = await beginPending(fixture);
  let callbacks = 0;
  await assert.rejects(fixture.service.batch(async () => callbacks++), {
    code: "MAINTENANCE",
  });
  assert.equal(callbacks, 0);
  await finishPending(pending);
});

test("active batch submission rejects before its callback", async (t) => {
  const fixture = await batchFixture(t);
  await suspendControlApplication(fixture.service);
  let callbacks = 0;
  await assert.rejects(fixture.service.batch(async () => callbacks++), {
    code: "MAINTENANCE",
  });
  assert.equal(callbacks, 0);
});

test("detached inherited context is stale after settlement and reopen", async (t) => {
  const fixture = await batchFixture(t);
  const first = Promise.withResolvers();
  const firstDone = Promise.withResolvers();
  const second = Promise.withResolvers();
  let detached;
  await fixture.service.batch(async () => {
    detached = (async () => {
      await first.promise;
      await assert.rejects(fixture.service.set("platform", "svc.keep", true), { code: "FORBIDDEN" });
      firstDone.resolve();
      await second.promise;
      await assert.rejects(fixture.service.set("platform", "svc.keep", true), { code: "FORBIDDEN" });
    })();
  });
  const commits = fixture.counters.commit;
  first.resolve();
  await firstDone.promise;
  await suspendControlApplication(fixture.service);
  reopen(fixture);
  second.resolve();
  await detached;
  assert.equal(fixture.counters.commit, commits);
});

test("rejected callback revokes its lease without stranding the fence", async (t) => {
  const fixture = await batchFixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const failure = new Error("private batch failure");
  const batch = fixture.service.batch(async () => {
    entered.resolve();
    await release.promise;
    throw failure;
  });
  await entered.promise;
  const fence = suspendControlApplication(fixture.service);
  release.resolve();
  await assert.rejects(batch, (error) => error === failure);
  await fence;
  assert.equal(fixture.host.coordinator.state(), "active");
});

test("service batch context does not authorize another service", async (t) => {
  const first = await batchFixture(t);
  const second = await batchFixture(t);
  await first.service.batch(async () => {
    await Promise.resolve();
    assert.equal((await second.service.set("platform", "svc.keep", true)).success, true);
  });
});

test("forged and other-barrier admission errors are not authentic", async () => {
  const first = createApplicationMaintenanceBarrier();
  const second = createApplicationMaintenanceBarrier();
  const release = Promise.withResolvers();
  const fence = first.closeApplicationAdmission(() => release.promise);
  const foreign = captureBarrierError(first);
  const forged = createWeaverError("MAINTENANCE", "forged secret");
  assert.equal(first.isAdmissionFailure(foreign), true);
  assert.equal(second.isAdmissionFailure(foreign), false);
  assert.equal(first.isAdmissionFailure(forged), false);
  release.resolve();
  await fence;
});

test("prior-generation admission errors are not authentic after reopen", async () => {
  const barrier = createApplicationMaintenanceBarrier();
  await barrier.closeApplicationAdmission(async () => undefined);
  const prior = captureBarrierError(barrier);
  assert.equal(barrier.isAdmissionFailure(prior), true);
  barrier.reopenApplicationAdmission();
  assert.equal(barrier.isAdmissionFailure(prior), false);
});

async function batchFixture(t) {
  const fixture = await createExclusiveMaintenanceFixture();
  t.after(() => fixture.close());
  return fixture;
}

function captureBarrierError(barrier) {
  try {
    barrier.assertApplicationAccess();
  } catch (error) {
    return error;
  }
  assert.fail("Expected admission error");
}
