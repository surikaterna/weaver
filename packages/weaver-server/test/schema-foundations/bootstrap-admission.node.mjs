import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hostForControl,
  suspendControlApplication,
} from "../../src/core/config-service-internal.ts";
import { fixture, registration } from "./fixtures.mjs";

const schema = {
  type: "object",
  properties: { enabled: { type: "boolean", default: true } },
};

test("draft registration preserves validation, revision, reads, and activation defaults", async () => {
  const { activate, configService, control, registry } = await fixture();
  try {
    const initialRevision = control.revision;
    const malformed = await registry.register(
      registration({
        type: "object",
        properties: { enabled: { type: "boolean", default: "yes" } },
      }),
    );
    assert.equal(malformed.success, false);
    assert.match(malformed.error.message, /default/i);
    assert.equal(control.revision, initialRevision);

    const registered = await registry.register(registration(schema));
    assert.equal(registered.success, true, registered.error?.message);
    assert.equal(registered.revision, control.revision);
    assert.notEqual(control.revision, initialRevision);
    assert.deepEqual(await registry.getSchema("svc", "dev"), schema);
    assert.equal((await registry.resolveAnchor("/svc", "dev"))?.path, "/svc");
    assert.deepEqual(registry.listAll()["/svc:dev"], schema);

    await activate();
    assert.equal(await configService.get("svc.enabled"), true);
  } finally {
    await configService.close();
  }
});

test("preactivation pending admission cannot fall back to draft control", async () => {
  const { configService, control, registry } = await fixture();
  const host = hostForControl(configService);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const blocker = host.coordinator.runControl(async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    const revision = control.revision;
    const fence = suspendControlApplication(configService);
    const result = await registry.register(registration(schema));
    assert.equal(result.error?.code, "MAINTENANCE");
    assert.equal(control.revision, revision);
    assert.throws(() => registry.listAll(), { code: "MAINTENANCE" });
    release.resolve();
    await Promise.all([blocker, fence]);
  } finally {
    release.resolve();
    await configService.close();
  }
});

test("registration after activation is fenced in pending and active phases", async () => {
  const { activate, configService, control, registry } = await fixture();
  const events = [];
  try {
    assert.equal((await registry.register(registration(schema))).success, true);
    await activate();
    configService.onDelta((delta) => events.push(delta));
    const host = hostForControl(configService);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const blocker = host.coordinator.runApplication(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const revision = control.revision;
    const fence = suspendControlApplication(configService);
    const pending = await registry.register(registration(schema));
    assert.equal(pending.error?.code, "MAINTENANCE");
    assert.equal(control.revision, revision);
    assert.deepEqual(events, []);
    release.resolve();
    await Promise.all([blocker, fence]);
    const active = await registry.register(registration(schema));
    assert.equal(active.error?.code, "MAINTENANCE");
    assert.equal(control.revision, revision);
    assert.deepEqual(events, []);
  } finally {
    await configService.close();
  }
});
