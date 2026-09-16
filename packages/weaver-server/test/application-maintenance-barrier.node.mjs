import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApplicationMaintenanceBarrier,
  maintenanceDrainDeadlineMs,
  waitForMaintenanceFence,
} from "../src/core/application-maintenance-barrier.ts";
import { MaintenanceController } from "../src/core/maintenance-controller.ts";

function deferred() {
  return Promise.withResolvers();
}

function maintenanceFixture() {
  const barrier = createApplicationMaintenanceBarrier();
  const order = [];
  let flushes = 0;
  let cleanup;
  const enter = () => {
    const fence = barrier.closeApplicationAdmission(async () => {
      await cleanup;
      order.push("flush");
      flushes++;
    });
    order.push("cancel-watch", "cancel-timer");
    cleanup ??= Promise.resolve();
    return fence;
  };
  return { barrier, order, enter, flushes: () => flushes };
}

test("preadmitted reads and writes drain before flush, active, and control", async () => {
  const fixture = maintenanceFixture();
  const readGate = deferred();
  const writeGate = deferred();
  let readRuns = 0;
  let writeRuns = 0;
  const read = fixture.barrier.runApplication(async () => {
    fixture.order.push("read-start");
    readRuns++;
    await readGate.promise;
    fixture.order.push("read-complete");
  });
  const write = fixture.barrier.runApplication(async () => {
    fixture.order.push("write-start");
    writeRuns++;
    await writeGate.promise;
    fixture.order.push("write-commit", "write-install");
  });
  const fence = fixture.enter();
  assert.deepEqual(fixture.order, ["cancel-watch", "cancel-timer"]);
  let rejectedRuns = 0;
  await assert.rejects(
    fixture.barrier.runApplication(() => rejectedRuns++),
    { code: "MAINTENANCE" },
  );
  const control = fixture.barrier.runControl(() => {
    assert.equal(fixture.barrier.state(), "active");
    fixture.order.push("control");
  });
  await Promise.resolve();
  assert.deepEqual(fixture.order, [
    "cancel-watch",
    "cancel-timer",
    "read-start",
  ]);
  readGate.resolve();
  await read;
  writeGate.resolve();
  await Promise.all([write, fence, control]);
  assert.deepEqual(fixture.order, [
    "cancel-watch",
    "cancel-timer",
    "read-start",
    "read-complete",
    "write-start",
    "write-commit",
    "write-install",
    "flush",
    "control",
  ]);
  assert.equal(readRuns, 1);
  assert.equal(writeRuns, 1);
  assert.equal(rejectedRuns, 0);
});

test("pending and active submissions reject before callback or queue insertion", async () => {
  const fixture = maintenanceFixture();
  const gate = deferred();
  const admitted = fixture.barrier.runApplication(() => gate.promise);
  const fence = fixture.enter();
  let callbacks = 0;
  await assert.rejects(
    fixture.barrier.runApplication(() => callbacks++),
    { code: "MAINTENANCE" },
  );
  gate.resolve();
  await Promise.all([admitted, fence]);
  await assert.rejects(
    fixture.barrier.runApplication(() => callbacks++),
    { code: "MAINTENANCE" },
  );
  await fixture.barrier.runControl(() => fixture.order.push("sentinel"));
  assert.equal(callbacks, 0);
  assert.deepEqual(fixture.order.slice(-2), ["flush", "sentinel"]);
});

test("repeated maintenance entry reuses its fence and final flush", async () => {
  const fixture = maintenanceFixture();
  const gate = deferred();
  const operation = fixture.barrier.runApplication(() => gate.promise);
  const first = fixture.enter();
  const second = fixture.enter();
  assert.equal(first, second);
  gate.resolve();
  await Promise.all([operation, first, second]);
  assert.equal(fixture.flushes(), 1);
  assert.equal(fixture.barrier.state(), "active");
  assert.equal(fixture.enter(), first);
  assert.equal(fixture.flushes(), 1);
});

test("bounded waiting times out fail-closed and keeps the same live fence", async () => {
  const fixture = maintenanceFixture();
  const operationGate = deferred();
  const deadline = deferred();
  const operation = fixture.barrier.runApplication(() => operationGate.promise);
  const fence = fixture.enter();
  let cancelled = false;
  const timer = {
    schedule(callback, delayMs) {
      assert.equal(delayMs, maintenanceDrainDeadlineMs);
      void deadline.promise.then(callback);
      return { fake: true };
    },
    cancel() {
      cancelled = true;
    },
  };
  let controlRan = false;
  const control = fixture.barrier.runControl(() => {
    controlRan = true;
  });
  deadline.resolve();
  await assert.rejects(waitForMaintenanceFence(fence, timer), {
    code: "MAINTENANCE",
  });
  assert.equal(cancelled, true);
  assert.equal(fixture.barrier.state(), "pending");
  assert.equal(controlRan, false);
  assert.equal(fixture.enter(), fence);
  operationGate.resolve();
  await Promise.all([operation, fence, control]);
  assert.equal(fixture.barrier.state(), "active");
  assert.equal(controlRan, true);
  assert.equal(fixture.flushes(), 1);
});

test("terminal admission reopens only after verification; restart and close stay denied", async () => {
  const fixture = maintenanceFixture();
  await fixture.enter();
  const verification = deferred();
  const admission = fixture.barrier.runControl(async () => {
    await verification.promise;
    fixture.barrier.reopenApplicationAdmission();
  });
  await assert.rejects(fixture.barrier.runApplication(() => undefined), {
    code: "MAINTENANCE",
  });
  verification.resolve();
  await admission;
  assert.equal(await fixture.barrier.runApplication(() => "ready"), "ready");
  fixture.barrier.sealApplicationAdmission();
  await assert.rejects(fixture.barrier.runApplication(() => undefined), {
    code: "SERVER_DEGRADED",
  });
});

test("a directly nested control transaction rejects instead of deadlocking", async () => {
  const barrier = createApplicationMaintenanceBarrier();
  await barrier.runControl(async () => {
    await assert.rejects(barrier.runControl(() => undefined), {
      code: "FORBIDDEN",
    });
  });
});

test("explicit leases allow async continuation without admitting unrelated work", async () => {
  const barrier = createApplicationMaintenanceBarrier();
  const release = deferred();
  const nestedEntered = deferred();
  const order = [];
  let applicationLease;
  const outer = barrier.runControl(async (controlLease) => {
    await Promise.resolve();
    await barrier.continueControl(controlLease, () => {
      order.push("nested-control");
      nestedEntered.resolve();
    });
    await release.promise;
  });
  const unrelated = barrier.runControl(() => order.push("unrelated"));
  await nestedEntered.promise;
  assert.deepEqual(order, ["nested-control"]);
  release.resolve();
  await Promise.all([outer, unrelated]);
  await barrier.runApplication(async (lease) => {
    applicationLease = lease;
    await Promise.resolve();
    await barrier.continueApplication(lease, () => {
      order.push("nested-application");
    });
  });
  assert.deepEqual(order, ["nested-control", "unrelated", "nested-application"]);
  await assert.rejects(
    barrier.continueApplication(applicationLease, () => undefined),
    { code: "FORBIDDEN" },
  );
});

test("forged, cross-kind, and stale leases reject", async () => {
  const barrier = createApplicationMaintenanceBarrier();
  let staleControl;
  let staleApplication;
  await barrier.runControl(async (controlLease) => {
    staleControl = controlLease;
    await assert.rejects(
      barrier.continueApplication(controlLease, () => undefined),
      { code: "FORBIDDEN" },
    );
  });
  await barrier.runApplication(async (applicationLease) => {
    staleApplication = applicationLease;
    await assert.rejects(
      barrier.continueControl(applicationLease, () => undefined),
      { code: "FORBIDDEN" },
    );
  });
  for (const [continuation, lease] of [
    [barrier.continueControl, {}],
    [barrier.continueControl, staleControl],
    [barrier.continueApplication, staleApplication],
  ])
    await assert.rejects(continuation(lease, () => undefined), {
      code: "FORBIDDEN",
    });
});

test("watch cleanup failures settle all disposers and keep the fence failed closed", async () => {
  const barrier = createApplicationMaintenanceBarrier();
  const calls = [];
  let flushes = 0;
  const providers = [
    watchProvider("sync", () => {
      calls.push("sync");
      throw new Error("secret sync cleanup");
    }),
    watchProvider("async", async () => {
      calls.push("async");
      throw new Error("secret async cleanup");
    }),
    {
      id: "dirty",
      layer: "dirty",
      dirty: true,
      flush: async () => {
        flushes++;
      },
    },
  ];
  const maintenance = new MaintenanceController({
    coordinator: barrier,
    providers,
    options: {},
    isClosed: false,
    suspendApplication() {},
  });
  maintenance.start();
  const first = maintenance.enter();
  const second = maintenance.enter();
  assert.equal(first, second);
  await assert.rejects(first, {
    code: "MAINTENANCE",
    message: "Maintenance request cleanup failed",
  });
  await assert.rejects(second, { code: "MAINTENANCE" });
  assert.deepEqual(calls, ["sync", "async"]);
  assert.equal(flushes, 0);
  assert.equal(barrier.state(), "pending");
  await assert.rejects(barrier.runControl(() => undefined), {
    code: "MAINTENANCE",
  });
});

function watchProvider(id, dispose) {
  return {
    id,
    layer: id,
    onExternalChange() {
      return dispose;
    },
  };
}
