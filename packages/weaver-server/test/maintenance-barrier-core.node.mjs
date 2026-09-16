import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createApplicationMaintenanceBarrier } from "../src/core/application-maintenance-barrier.ts";
import {
  beginPending,
  createExclusiveMaintenanceFixture,
  finishPending,
  registrationRequest,
  reopen,
  runBeforePending,
} from "./exclusive-maintenance-fixture.mjs";

const families = [
  {
    name: "reads",
    before: (f) => {
      assert.equal(f.service.revision.length > 0, true);
      assert.equal(f.service.layout !== undefined, true);
      return Promise.allSettled([
        f.service.resolveAll(),
        f.service.get("svc.keep"),
        f.service.getNamespace("svc"),
        f.service.inspect("svc.keep"),
        f.service.authoritySnapshot(),
      ]);
    },
    denied: async (f) => {
      await assert.rejects(f.service.get("svc.keep"), { code: "MAINTENANCE" });
      await assert.rejects(f.service.authoritySnapshot(), {
        code: "MAINTENANCE",
      });
    },
  },
  {
    name: "writes",
    before: (f) => f.service.setMany("platform", { "svc.keep": true }),
    denied: async (f) => {
      const results = await Promise.all([
        f.service.set("platform", "svc.keep", false),
        f.service.remove("platform", "svc.keep"),
      ]);
      for (const result of results)
        assert.equal(result.error?.code, "MAINTENANCE");
    },
  },
  {
    name: "registration",
    before: async (f) => {
      const revision = f.service.revision;
      f.registry.listAll();
      const [, , result] = await Promise.all([
        f.registry.getSchema("svc", "test"),
        f.registry.resolveAnchor("/svc", "test"),
        f.registry.register(registrationRequest(), {
          expectedRevision: revision,
        }),
      ]);
      assert.equal(result.success, true, result.error?.message);
    },
    denied: async (f) => {
      assert.throws(() => f.registry.listAll(), { code: "MAINTENANCE" });
      await assert.rejects(f.registry.getSchema("svc", "test"), {
        code: "MAINTENANCE",
      });
      const result = await f.registry.register(registrationRequest("denied"));
      assert.equal(result.error?.code, "MAINTENANCE");
    },
  },
  {
    name: "scope",
    before: async (f) => {
      const revision = f.service.revision;
      f.scopes.listScopes();
      f.scopes.listScopeValues("tenant");
      const [, result] = await Promise.all([
        f.service.assertScopeMembership(f.scopePath),
        f.scopes.provision({
          scopePath: f.scopePath,
          actor: "matrix",
          expectedRevision: revision,
        }),
      ]);
      assert.equal(result.success, true, result.error?.message);
    },
    denied: async (f) => {
      assert.throws(() => f.scopes.listScopes(), { code: "MAINTENANCE" });
      assert.throws(() => f.scopes.listScopeValues("tenant"), {
        code: "MAINTENANCE",
      });
      await assert.rejects(f.service.assertScopeMembership(f.scopePath), {
        code: "MAINTENANCE",
      });
      const result = await f.scopes.deprovision({ scopePath: f.scopePath });
      assert.equal(result.error?.code, "MAINTENANCE");
    },
  },
  {
    name: "watch/reload",
    before: (f) =>
      Promise.all([
        f.service.reloadProvider("app"),
        f.service.refreshProviders(),
      ]),
    denied: (f) =>
      assert.rejects(f.service.refreshProviders(), { code: "MAINTENANCE" }),
    capture: (f) => f.counters.listener,
    afterB: async (f, callback) => {
      const loads = f.counters.load;
      callback([]);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(f.counters.load, loads);
    },
  },
  {
    name: "projection/listener",
    before: async (f) => {
      let callbacks = 0;
      f.service.onDelta(() => callbacks++);
      const commits = f.counters.commit;
      const result = await f.service.set("platform", "svc.keep", true);
      assert.equal(result.success, true);
      assert.equal(f.counters.commit, commits + 1);
      assert.equal(callbacks, 0);
    },
    denied: (f) =>
      assert.throws(() => f.service.onDelta(() => undefined), {
        code: "MAINTENANCE",
      }),
    capture: (f) => f.counters.flush,
    afterB: (f, flushes) => assert.equal(f.counters.flush, flushes + 1),
  },
  {
    name: "timer/public flush",
    before: (f) => f.service.flush(),
    denied: (f) =>
      assert.rejects(f.service.flush(), { code: "MAINTENANCE" }),
  },
];

for (const family of families) matrixFamily(family);

function matrixFamily(family) {
  describe(`core family ${family.name}`, { concurrency: false }, () => {
    let fixture;
    before(async () => {
      fixture = await createExclusiveMaintenanceFixture();
    });
    after(async () => fixture.close());
    test(`${family.name} B drains before active`, async () => {
      const captured = family.capture?.(fixture);
      await runBeforePending(fixture, () => family.before(fixture));
      assert.equal(fixture.host.coordinator.state(), "active");
      await family.afterB?.(fixture, captured);
    });
    test(`${family.name} P rejects before effects`, async () => {
      reopen(fixture);
      const pending = await beginPending(fixture);
      const snapshot = effectSnapshot(fixture);
      await family.denied(fixture);
      assert.deepEqual(effectSnapshot(fixture), snapshot);
      await finishPending(pending);
    });
    test(`${family.name} A rejects before effects`, async () => {
      const snapshot = effectSnapshot(fixture);
      await family.denied(fixture);
      assert.deepEqual(effectSnapshot(fixture), snapshot);
    });
  });
}

const providerGroups = [
  {
    name: "provider read",
    ready: async (provider) => {
      assert.equal((await provider.load()).entries !== undefined, true);
      assert.equal((await provider.loadLayer("platform")).entries !== undefined, true);
      await provider.authority.readLayer("platform");
      await provider.authority.inventory();
      await provider.authority.preflight();
    },
    invoke: (provider) =>
      Promise.all([
        provider.load(),
        provider.loadLayer("platform"),
        provider.authority.readLayer("platform"),
        provider.authority.inventory(),
      ]),
  },
  {
    name: "provider mutation",
    ready: async (provider) => {
      for (const operation of providerMutations(provider))
        await assert.rejects(operation, { code: "FORBIDDEN" });
    },
    invoke: (provider) => Promise.all(providerMutations(provider)),
  },
  {
    name: "provider flush/watch",
    ready: async (provider) => {
      await assert.rejects(provider.flush(), { code: "FORBIDDEN" });
      assert.throws(() => provider.onExternalChange(() => undefined), { code: "FORBIDDEN" });
    },
    invoke: providerFlushAndWatch,
  },
];

for (const group of providerGroups) providerMatrix(group);

function providerMatrix(group) {
  describe(group.name, { concurrency: false }, () => {
    let fixture;
    let provider;
    before(async () => {
      fixture = await createExclusiveMaintenanceFixture();
      provider = fixture.service.providers.find(({ id }) => id === "app");
    });
    after(async () => fixture.close());
    test(`${group.name} ready policy`, async () => {
      assert.equal(Object.isFrozen(provider), true);
      assert.equal(fixture.service.providers, fixture.service.providers);
      assert.notEqual(
        provider,
        fixture.host.providers.find(({ id }) => id === "app"),
      );
      await group.ready(provider);
    });
    test(`${group.name} P is MAINTENANCE`, async () => {
      const pending = await beginPending(fixture);
      await assert.rejects(Promise.resolve().then(() => group.invoke(provider)), {
        code: "MAINTENANCE",
      });
      await finishPending(pending);
    });
    test(`${group.name} A is MAINTENANCE`, async () => {
      await assert.rejects(Promise.resolve().then(() => group.invoke(provider)), {
        code: "MAINTENANCE",
      });
    });
  });
}

function providerMutations(provider) {
  return [
    () => provider.write("svc.keep", true),
    () => provider.remove("svc.keep"),
    () => provider.writeLayer("platform", "svc.keep", true),
    () => provider.removeLayer("platform", "svc.keep"),
    () => provider.refresh(),
    () => provider.authority.acquireWriter("public"),
    () => provider.authority.releaseWriter({ ownerId: "public" }),
    () => provider.authority.commitLayer({}, { ownerId: "public" }),
  ].map((operation) => Promise.resolve().then(operation));
}

async function providerFlushAndWatch(provider) {
  let watchError;
  try {
    provider.onExternalChange(() => undefined);
  } catch (error) {
    watchError = error;
  }
  await provider.flush();
  throw watchError;
}

test("drain controlled B release precedes active and final flush", async () => {
  const barrier = createApplicationMaintenanceBarrier();
  const release = Promise.withResolvers();
  const order = [];
  const work = barrier.runApplication(async () => {
    await release.promise;
    order.push("B");
  });
  const fence = barrier.closeApplicationAdmission(async () => order.push("flush"));
  release.resolve();
  await Promise.all([work, fence]);
  assert.deepEqual(order, ["B", "flush"]);
});

test("drain P/A submissions never enter the queue", async () => {
  const barrier = createApplicationMaintenanceBarrier();
  let calls = 0;
  await barrier.closeApplicationAdmission(async () => undefined);
  await assert.rejects(barrier.runApplication(() => calls++), { code: "MAINTENANCE" });
  assert.equal(calls, 0);
});

test("drain timeout leaves same pending fence to completion", async () => {
  const barrier = createApplicationMaintenanceBarrier();
  const release = Promise.withResolvers();
  const work = barrier.runApplication(() => release.promise);
  const first = barrier.closeApplicationAdmission(async () => undefined);
  const second = barrier.closeApplicationAdmission(async () => undefined);
  assert.equal(first, second);
  assert.equal(barrier.state(), "pending");
  release.resolve();
  await Promise.all([work, first]);
  assert.equal(barrier.state(), "active");
});

function effectSnapshot(fixture) {
  const { load, commit, refresh, flush, watch, watchDispose } = fixture.counters;
  return { load, commit, refresh, flush, watch, watchDispose };
}
