import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { maintenanceDrainDeadlineMs } from "../src/core/application-maintenance-barrier.ts";
import {
  hostForControl,
  runMaintenanceOperation,
} from "../src/core/config-service-internal.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";

const schemas = {
  svc: {
    type: "object",
    properties: { keep: { type: "boolean" } },
    additionalProperties: false,
  },
};

function deferred() {
  return Promise.withResolvers();
}

test("runtime closes central admission synchronously and drains leased work", async () => {
  const standalone = await createStandaloneFixture({ schemas });
  let runtime;
  try {
    await initializeWeaver(
      standalone.seed,
      standalone.request,
      standalone.administrator,
      { credentials: standalone.credentials },
    );
    runtime = await openWeaverRuntime(standalone.seed, {
      credentials: standalone.credentials,
    });
    const provider = hostForControl(runtime.configService).providers.find(
      ({ id }) => id === "platform",
    );
    const entered = deferred();
    const release = deferred();
    const order = [];
    const original = provider.authority.commitLayer.bind(provider.authority);
    mock.method(provider.authority, "commitLayer", async (request, handle) => {
      if (request.mutation.key === "svc.keep") {
        order.push("write-start");
        entered.resolve();
        await release.promise;
      }
      const result = await original(request, handle);
      if (request.mutation.key === "svc.keep") order.push("write-commit");
      return result;
    });
    const write = runtime.configService.set("platform", "svc.keep", true);
    await entered.promise;
    const read = runtime.configService.get("svc.keep").then((value) => {
      order.push("read");
      return value;
    });
    let notified = false;
    runtime.onMaintenance(() => {
      notified = true;
    });
    const entering = runtime.enterMaintenance().then(() => order.push("active"));
    assert.equal(runtime.state, "maintenance");
    assert.equal(notified, true);
    await assert.rejects(runtime.configService.get("svc.keep"), {
      code: "MAINTENANCE",
    });
    const denied = await runtime.configService.set("platform", "svc.keep", false);
    assert.equal(denied.error.code, "MAINTENANCE");
    const control = runMaintenanceOperation(runtime.configService, async (host) => {
      assert.equal(host.coordinator.state(), "active");
      order.push("control");
    });
    release.resolve();
    assert.equal((await write).success, true);
    assert.equal(await read, true);
    await Promise.all([entering, control]);
    assert.deepEqual(order, [
      "write-start",
      "write-commit",
      "read",
      "control",
      "active",
    ]);
  } finally {
    mock.restoreAll();
    await runtime?.close();
    await standalone.dispose();
  }
});

test("runtime bounded wait times out while the same fence keeps draining", async (t) => {
  const standalone = await createStandaloneFixture({ schemas });
  let runtime;
  try {
    await initializeWeaver(
      standalone.seed,
      standalone.request,
      standalone.administrator,
      { credentials: standalone.credentials },
    );
    runtime = await openWeaverRuntime(standalone.seed, {
      credentials: standalone.credentials,
    });
    const provider = hostForControl(runtime.configService).providers.find(
      ({ id }) => id === "platform",
    );
    const entered = deferred();
    const release = deferred();
    const original = provider.authority.commitLayer.bind(provider.authority);
    t.mock.method(provider.authority, "commitLayer", async (request, handle) => {
      if (request.mutation.key === "svc.keep") {
        entered.resolve();
        await release.promise;
      }
      return original(request, handle);
    });
    const write = runtime.configService.set("platform", "svc.keep", true);
    await entered.promise;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entering = runtime.enterMaintenance();
    t.mock.timers.tick(maintenanceDrainDeadlineMs);
    await assert.rejects(entering, { code: "MAINTENANCE" });
    const host = hostForControl(runtime.configService);
    assert.equal(runtime.state, "maintenance");
    assert.equal(host.coordinator.state(), "pending");
    let controlRan = false;
    const control = runMaintenanceOperation(runtime.configService, async () => {
      controlRan = true;
    });
    await Promise.resolve();
    assert.equal(controlRan, false);
    t.mock.timers.reset();
    release.resolve();
    assert.equal((await write).success, true);
    await control;
    assert.equal(controlRan, true);
    assert.equal(host.coordinator.state(), "active");
    await runtime.enterMaintenance();
  } finally {
    t.mock.timers.reset();
    await runtime?.close();
    await standalone.dispose();
  }
});

test("throwing lifecycle listeners leave runtime maintenance pending", async () => {
  const standalone = await createStandaloneFixture({ schemas });
  let runtime;
  try {
    await initializeWeaver(
      standalone.seed,
      standalone.request,
      standalone.administrator,
      { credentials: standalone.credentials },
    );
    runtime = await openWeaverRuntime(standalone.seed, {
      credentials: standalone.credentials,
    });
    let delivered = false;
    runtime.onMaintenance(() => {
      throw new Error("secret listener failure");
    });
    runtime.onMaintenance(() => {
      delivered = true;
    });
    await assert.rejects(runtime.enterMaintenance(), {
      code: "MAINTENANCE",
      message: "Maintenance request cleanup failed",
    });
    const host = hostForControl(runtime.configService);
    assert.equal(delivered, true);
    assert.equal(runtime.state, "maintenance");
    assert.equal(host.coordinator.state(), "pending");
    await assert.rejects(runMaintenanceOperation(runtime.configService, async () => {}), {
      code: "MAINTENANCE",
    });
  } finally {
    await runtime?.close();
    await standalone.dispose();
  }
});
