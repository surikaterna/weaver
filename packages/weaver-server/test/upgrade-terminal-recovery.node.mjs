import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  BUILTIN_CATALOG_REFERENCE,
  canonicalInternalJson,
  internalRegistrationId,
} from "@weaver-conf/config-types";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import {
  controlProjection,
  hostForControl,
} from "../src/core/config-service-internal.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";

const sourceSchema = {
  type: "object",
  properties: { keep: { type: "boolean" } },
  additionalProperties: false,
};
const targetSchema = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    added: { type: "string", default: "planned" },
  },
  additionalProperties: false,
};

test("completed application terminal recovery is repeatable and keeps ordinary traffic ready", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    assert.equal(
      (await runtime.configService.set("platform", "svc.keep", true)).success,
      true,
    );
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    assert.equal(outcome.status, "completed");
    assert.ok(terminalJournal(runtime, outcome.runId).control);
    const effects = observeTerminalEffects(t, runtime);
    let keep = true;
    for (const next of [false, true, false]) {
      const before = effects.snapshot();
      const recovered = await runtime.recoverUpgrade({
        version: 1,
        runId: outcome.runId,
      });
      assert.equal(recovered.status, "completed");
      assert.equal("journal" in recovered, false);
      effects.assertUnchanged(before);
      assert.equal(runtime.state, "ready");
      assert.deepEqual(await runtime.configService.get("svc"), {
        keep,
        added: "planned",
      });
      assert.equal(
        (await runtime.configService.set("platform", "svc.keep", next)).success,
        true,
      );
      keep = next;
      assert.deepEqual(await runtime.configService.get("svc"), {
        keep,
        added: "planned",
      });
    }
    effects.close();
  });
});

test("completed terminal recovery restores an already suspended application", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    assert.equal(
      (await runtime.configService.set("platform", "svc.keep", true)).success,
      true,
    );
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    const events = observeEvents(runtime);
    await runtime.enterMaintenance();
    const observation = observeTerminalRetries(t, runtime, events);
    const [recovered] = await recoverThreeTimes(runtime, outcome.runId);
    assert.equal(recovered.status, "completed");
    observation.assertUnchanged();
    assert.equal(runtime.state, "ready");
    assert.deepEqual(await runtime.configService.get("svc"), {
      keep: true,
      added: "planned",
    });
  });
});

test("suspended terminal recovery admits a later validated application revision without replay", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    assert.equal(
      (await runtime.configService.set("platform", "svc.keep", false)).success,
      true,
    );
    const effects = observeTerminalEffects(t, runtime);
    const before = effects.snapshot();
    await runtime.enterMaintenance();
    assert.equal(
      (await runtime.recoverUpgrade({ version: 1, runId: outcome.runId })).status,
      "completed",
    );
    effects.assertUnchanged(before);
    assert.equal(runtime.state, "ready");
    assert.deepEqual(await runtime.configService.get("svc"), {
      keep: false,
      added: "planned",
    });
    effects.close();
  });
});

for (const target of ["builtin", "infrastructure", "combined"]) {
  test(`${target} terminal recovery remains restart-required and rejects ordinary traffic`, async (t) => {
    await withRuntime(t, async ({ runtime, initialization }) => {
      assert.equal(
        (await runtime.configService.set("platform", "svc.keep", true)).success,
        true,
      );
      const events = observeEvents(runtime);
      const outcome = await runtime.applyUpgrade({
        version: 1,
        request: planRequest(runtime, initialization, target),
      });
      assert.equal(outcome.status, "restart-required");
      assert.ok(terminalJournal(runtime, outcome.runId).control);
      const observation = observeTerminalRetries(t, runtime, events);
      const retries = await recoverThreeTimes(runtime, outcome.runId);
      assert.deepEqual(
        retries.map((result) => result.status),
        ["restart-required", "restart-required", "restart-required"],
      );
      observation.assertUnchanged();
      assert.equal(runtime.state, "restart_required");
      await assert.rejects(runtime.configService.get("svc"), {
        code: "MAINTENANCE",
      });
      const write = await runtime.configService.set("platform", "svc.keep", true);
      assert.equal(write.success, false);
      assert.equal(write.error?.code, "MAINTENANCE");
    });
  });
}

test("compensated application-only recovery restores validated source admission", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    assert.equal(
      (await runtime.configService.set("platform", "svc.keep", true)).success,
      true,
    );
    const events = observeEvents(runtime);
    const runId = await compensateAfterActivationFailure(
      t,
      runtime,
      planRequest(runtime, initialization),
    );
    assert.ok(terminalJournal(runtime, runId).control);
    const observation = observeTerminalRetries(t, runtime, events);
    const retries = await recoverThreeTimes(runtime, runId);
    assert.deepEqual(
      retries.map((result) => result.status),
      ["compensated", "compensated", "compensated"],
    );
    observation.assertUnchanged();
    assert.equal(runtime.state, "ready");
    assert.deepEqual(await runtime.configService.get("svc"), { keep: true });
  });
});

test("compensated recovery with an infrastructure transition stays nonready", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    assert.equal(
      (await runtime.configService.set("platform", "svc.keep", true)).success,
      true,
    );
    const events = observeEvents(runtime);
    const runId = await compensateAfterActivationFailure(
      t,
      runtime,
      planRequest(runtime, initialization, "infrastructure"),
    );
    assert.ok(terminalJournal(runtime, runId).control);
    const observation = observeTerminalRetries(t, runtime, events);
    const retries = await recoverThreeTimes(runtime, runId);
    assert.deepEqual(
      retries.map((result) => result.status),
      ["restart-required", "restart-required", "restart-required"],
    );
    assert.ok(retries.every((result) => !("journal" in result)));
    observation.assertUnchanged();
    assert.equal(runtime.state, "restart_required");
    await assert.rejects(runtime.configService.get("svc"), {
      code: "MAINTENANCE",
    });
  });
});

test("compensated recovery with mismatched source data stays nonready", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    assert.equal(
      (await runtime.configService.set("platform", "svc.keep", true)).success,
      true,
    );
    const events = observeEvents(runtime);
    const runId = await compensateAfterActivationFailure(
      t,
      runtime,
      planRequest(runtime, initialization),
    );
    assert.ok(terminalJournal(runtime, runId).control);
    const platform = runtime.configService.providers.find(
      (provider) => provider.id === "platform",
    );
    const read = platform.authority.readLayer.bind(platform.authority);
    t.mock.method(platform.authority, "readLayer", async (layer) => {
      const envelope = await read(layer);
      return { ...envelope, entries: { svc: { keep: false } } };
    });
    const observation = observeTerminalRetries(t, runtime, events);
    const retries = await recoverThreeTimes(runtime, runId);
    assert.ok(retries.every((result) => result.status === "restart-required"));
    observation.assertUnchanged();
    assert.equal(runtime.state, "restart_required");
    await assert.rejects(runtime.configService.get("svc"), {
      code: "MAINTENANCE",
    });
  });
});

test("completed terminal contradictions fail closed without retry effects", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    const events = observeEvents(runtime);
    const effects = observeTerminalEffects(t, runtime, events);
    const mutations = [
      (journal) => {
        delete journal.activation.terminal;
      },
      (journal) => {
        journal.activation.terminal = "restart-required";
      },
      (journal) => {
        journal.phase = "restart-required";
      },
      (journal) => {
        journal.target.id = "forged-catalog";
      },
      (journal) => {
        journal.target.version++;
      },
      (journal) => {
        journal.target.digest = "0".repeat(64);
      },
      (journal) => {
        journal.infrastructureGeneration = "forged-generation";
      },
      (journal) => {
        journal.activation.operationId = "00000000-0000-4000-8000-000000000001";
      },
      (journal) => {
        journal.activation.mutationDigest = "0".repeat(64);
      },
      (journal) => {
        journal.activation.prestateDigest = "0".repeat(64);
      },
      (journal) => {
        journal.activation.candidateDigest = "0".repeat(64);
      },
      (journal) => {
        journal.activation.poststateDigest = "0".repeat(64);
      },
      (journal) => {
        journal.activation.receipt.revision.sequence = "999";
      },
      (journal) => {
        journal.activation.receipt.mutationDigest = "0".repeat(64);
      },
      (journal) => {
        journal.activation.target.catalogDigest = "0".repeat(64);
      },
      (journal) => {
        journal.activation.target.targetInfrastructureGeneration = "forged";
      },
      (journal) => {
        delete journal.activation.finalContexts;
      },
      (journal) => {
        journal.activation.finalContexts.nonce = "0".repeat(64);
      },
      (journal) => {
        journal.activation.finalContexts.runId =
          "22222222-2222-4222-8222-222222222222";
      },
      (journal) => {
        journal.activation.finalContexts.aggregateDigest = "0".repeat(64);
      },
      (journal) => {
        journal.activation.finalContexts.contexts[0].scopePath = [
          { scopeId: "region", value: "forged" },
        ];
      },
      (journal) => {
        journal.activation.finalContexts.contexts[0].authorityVector.reverse();
      },
      (journal) => {
        journal.activation.finalContexts.contexts[0].deliveredDigest = "0".repeat(64);
      },
      (journal) => {
        journal.activation.finalContexts.planId = "0".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      exposeJournalMutation(runtime, terminalJournal(runtime, outcome.runId), mutate);
      await assertTerminalRejections(runtime, outcome.runId, effects);
    }
    effects.close();
  });
});

test("terminal control store and environment mutations fail closed", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    const events = observeEvents(runtime);
    const effects = observeTerminalEffects(t, runtime, events);
    for (const mutate of [
      (journal) => {
        journal.control.revision.storeId = "forged-store";
      },
      (journal) => {
        journal.control.revision.environment = "forged";
      },
      (journal) => {
        journal.activation.control.providerId = "forged-provider";
      },
      (journal) => {
        journal.activation.control.namespace = "forged-namespace";
      },
      (journal) => {
        journal.activation.control.revision.storeId = "forged-store";
      },
      (journal) => {
        journal.activation.control.revision.environment = "forged";
      },
    ]) {
      exposeJournalMutation(runtime, terminalJournal(runtime, outcome.runId), mutate);
      await assertTerminalRejections(runtime, outcome.runId, effects);
    }
    effects.close();
  });
});

test("terminal recovery without a control binding fails closed", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    assert.ok(terminalJournal(runtime, outcome.runId).control);
    const events = observeEvents(runtime);
    exposeJournalMutation(runtime, terminalJournal(runtime, outcome.runId), (journal) => {
      delete journal.control;
    });
    const effects = observeTerminalEffects(t, runtime, events);
    await assertTerminalRejections(runtime, outcome.runId, effects);
    effects.close();
  });
});

test("restart-required terminal contradictions never reopen traffic", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const events = observeEvents(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization, "infrastructure"),
    });
    const effects = observeTerminalEffects(t, runtime, events);
    for (const mutate of [
      (journal) => {
        delete journal.activation.terminal;
      },
      (journal) => {
        journal.activation.terminal = "completed";
      },
      (journal) => {
        journal.phase = "completed";
      },
      (journal) => {
        journal.target.digest = "0".repeat(64);
      },
    ]) {
      exposeJournalMutation(runtime, terminalJournal(runtime, outcome.runId), mutate);
      await assertTerminalRejections(runtime, outcome.runId, effects);
    }
    effects.close();
  });
});

test("compensated terminal source and target contradictions fail closed", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const events = observeEvents(runtime);
    const runId = await compensateAfterActivationFailure(
      t,
      runtime,
      planRequest(runtime, initialization),
    );
    const journal = terminalJournal(runtime, runId);
    const effects = observeTerminalEffects(t, runtime, events);
    for (const mutate of [
      (candidate) => {
        candidate.activation.terminal = "restart-required";
      },
      (candidate) => {
        candidate.target.digest = "0".repeat(64);
      },
      (candidate) => {
        candidate.source.digest = "0".repeat(64);
      },
    ]) {
      exposeJournalMutation(runtime, journal, mutate);
      await assertTerminalRejections(runtime, runId, effects);
    }
    effects.close();
  });
});

test("persisted plan target mutation is rejected without recovery effects", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    const events = observeEvents(runtime);
    await runtime.enterMaintenance();
    const journal = terminalJournal(runtime, outcome.runId);
    const plan = controlProjection(runtime.configService).prepared().configuration
      .upgrades.plans[journal.planId];
    const changed = structuredClone(plan);
    changed.target.catalogDigest = "0".repeat(64);
    const { id: _id, ...body } = changed;
    changed.id = digest(body);
    await commitDurableControl(runtime, (state) => {
      state.upgrades.plans[changed.id] = changed;
      state.upgrades.journal[journal.runId].planId = changed.id;
    });
    const effects = observeTerminalEffects(t, runtime, events);
    await assertTerminalRejections(runtime, outcome.runId, effects);
    effects.close();
  });
});

test("durable terminal divergence overrides a stale valid cache", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    await commitDurableControl(runtime, (state) => {
      state.upgrades.journal[outcome.runId].activation.mutationDigest =
        "0".repeat(64);
    }, true);
    const effects = observeTerminalEffects(t, runtime);
    await assertTerminalRejections(runtime, outcome.runId, effects);
    effects.close();
  });
});

test("exact durable terminal authority rejects an incorrect cache", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    exposeJournalMutation(runtime, terminalJournal(runtime, outcome.runId), (journal) => {
      journal.activation.mutationDigest = "0".repeat(64);
    });
    const effects = observeTerminalEffects(t, runtime);
    await assertTerminalRejections(runtime, outcome.runId, effects);
    effects.close();
  });
});

test("completed recovery rejects divergent application context authority", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    await runtime.enterMaintenance();
    const platform = runtime.configService.providers.find(
      (provider) => provider.id === "platform",
    );
    const read = platform.authority.readLayer.bind(platform.authority);
    t.mock.method(platform.authority, "readLayer", async (layer) => {
      const envelope = structuredClone(await read(layer));
      envelope.entries.svc.keep = false;
      return envelope;
    });
    await assert.rejects(
      runtime.recoverUpgrade({ version: 1, runId: outcome.runId }),
      { code: "VALIDATION_ERROR" },
    );
    assert.equal(runtime.state, "restart_required");
    await assert.rejects(runtime.configService.get("svc"), {
      code: "MAINTENANCE",
    });
  });
});

test("authority change in the terminal admission verifier fails closed", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    const provider = controlProvider(runtime);
    const read = provider.authority.readLayer.bind(provider.authority);
    let reads = 0;
    t.mock.method(provider.authority, "readLayer", async (layer) => {
      const envelope = await read(layer);
      reads++;
      if (reads < 3) return envelope;
      const changed = structuredClone(envelope);
      changed.sequence = (BigInt(changed.sequence) + 1n).toString();
      changed.entries._weaver.upgrades.journal[
        outcome.runId
      ].activation.mutationDigest = "0".repeat(64);
      return changed;
    });
    const effects = observeTerminalEffects(t, runtime);
    const before = effects.snapshot();
    await assert.rejects(
      runtime.recoverUpgrade({ version: 1, runId: outcome.runId }),
      { code: "VALIDATION_ERROR" },
    );
    assert.equal(reads, 3);
    effects.assertUnchanged(before);
    assert.equal(runtime.state, "restart_required");
    effects.close();
  });
});

test("terminal verification and admission share one coordinator lease", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    await runtime.enterMaintenance();
    const host = hostForControl(runtime.configService);
    const run = host.coordinator.run.bind(host.coordinator);
    const open = host.openApplication.bind(host);
    const install = host.installUpgradeSnapshot.bind(host);
    const ordering = [];
    let queued;
    t.mock.method(host, "installUpgradeSnapshot", (...arguments_) => {
      ordering.push("read");
      install(...arguments_);
    });
    t.mock.method(host, "openApplication", () => {
      ordering.push("open");
      open();
    });
    t.mock.method(host.coordinator, "run", async (operation) => {
      const result = await run(operation);
      if (ordering.includes("read") && !queued)
        queued = run(async () => ordering.push("queued mutation"));
      return result;
    });
    const recovered = await runtime.recoverUpgrade({
      version: 1,
      runId: outcome.runId,
    });
    await queued;
    assert.equal(recovered.status, "completed");
    assert.deepEqual(ordering, ["read", "open", "queued mutation"]);
    assert.equal(runtime.state, "ready");
  });
});

test("runtime reflection cannot forge application admission", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    await runtime.enterMaintenance();
    const ownNames = Object.getOwnPropertyNames(runtime).sort();
    const prototype = Object.getPrototypeOf(runtime);
    const prototypeNames = Object.getOwnPropertyNames(prototype);
    const symbols = [
      ...Object.getOwnPropertySymbols(runtime),
      ...Object.getOwnPropertySymbols(prototype),
    ];
    assert.deepEqual(ownNames, ["configService", "schemaRegistry", "scopeManager"]);
    assert.equal(
      prototypeNames.some((name) =>
        /admission|host|opened|provider|resume|verif/i.test(name),
      ),
      false,
    );
    assert.equal(symbols.length, 0);
    assert.throws(() => new runtime.constructor(Symbol(), {}), {
      code: "FORBIDDEN",
    });
    assert.equal(runtime.state, "maintenance");
    await assert.rejects(runtime.configService.get("svc"), {
      code: "MAINTENANCE",
    });
    assert.equal(
      (await runtime.recoverUpgrade({ version: 1, runId: outcome.runId })).status,
      "completed",
    );
    assert.equal(runtime.state, "ready");
  });
});

test("a later exact durable control rewrite preserves terminal admission", async (t) => {
  await withRuntime(t, async ({ runtime, initialization }) => {
    await writeSource(runtime);
    const outcome = await runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, initialization),
    });
    await commitDurableControl(runtime, () => undefined, false);
    const effects = observeTerminalEffects(t, runtime);
    const before = effects.snapshot();
    assert.equal(
      (await runtime.recoverUpgrade({ version: 1, runId: outcome.runId })).status,
      "completed",
    );
    effects.assertUnchanged(before);
    assert.equal(runtime.state, "ready");
    effects.close();
  });
});

async function withRuntime(t, operation) {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(
      fixture.seed,
      fixture.request,
      fixture.administrator,
      { credentials: fixture.credentials },
    );
    runtime = await openWeaverRuntime(fixture.seed, {
      credentials: fixture.credentials,
    });
    await operation({ runtime, initialization: fixture.request });
    await runtime.close();
    await runtime.close();
    runtime = undefined;
  } finally {
    t.mock.restoreAll();
    await runtime?.close();
    await fixture.dispose();
  }
}

function observeEvents(runtime) {
  const events = [];
  const unsubscribe = runtime.configService.onDelta((event) => events.push(event));
  return { events, unsubscribe };
}

function observeTerminalRetries(t, runtime, existing) {
  const effects = observeTerminalEffects(t, runtime, existing);
  const before = effects.snapshot();
  return {
    assertUnchanged() {
      effects.assertUnchanged(before);
      effects.close();
    },
  };
}

function observeTerminalEffects(t, runtime, existing) {
  const observation = existing ?? observeEvents(runtime);
  const commits = runtime.configService.providers.map((provider) =>
    t.mock.method(provider.authority, "commitLayer"),
  );
  const configSubscriptions = t.mock.method(runtime.configService, "onDelta");
  const providerSubscriptions = runtime.configService.providers.flatMap(
    (provider) =>
      provider.onExternalChange
        ? [t.mock.method(provider, "onExternalChange")]
        : [],
  );
  return {
    snapshot() {
      return {
        revision: runtime.configService.revision,
        events: observation.events.length,
        commits: commits.map((commit) => commit.mock.callCount()),
        configSubscriptions: configSubscriptions.mock.callCount(),
        providerSubscriptions: providerSubscriptions.map((subscription) =>
          subscription.mock.callCount(),
        ),
      };
    },
    assertUnchanged(before) {
      assert.deepEqual(this.snapshot(), before);
    },
    close() {
      observation.unsubscribe();
    },
  };
}

async function assertTerminalRejections(runtime, runId, effects) {
  for (let retry = 0; retry < 3; retry++) {
    const before = effects.snapshot();
    await assert.rejects(
      runtime.recoverUpgrade({ version: 1, runId }),
      (error) => ["VALIDATION_ERROR", "UNSUPPORTED_AUTHORITY"].includes(error.code),
    );
    effects.assertUnchanged(before);
    assert.equal(runtime.state, "restart_required");
    await assert.rejects(runtime.configService.get("svc"), {
      code: "MAINTENANCE",
    });
    const write = await runtime.configService.set("platform", "svc.keep", true);
    assert.equal(write.success, false);
    assert.equal(write.error?.code, "MAINTENANCE");
  }
}

async function persistJournalMutation(runtime, source, mutate) {
  const journal = structuredClone(source);
  mutate(journal);
  await commitDurableControl(runtime, (state) => {
    state.upgrades.journal[journal.runId] = journal;
  });
}

function exposeJournalMutation(runtime, source, mutate) {
  const journal = structuredClone(source);
  mutate(journal);
  const host = hostForControl(runtime.configService);
  const providerId = host.pipeline.controlProvider.id;
  const entries = structuredClone(host.layerData.get(providerId));
  entries._weaver.upgrades.journal[journal.runId] = journal;
  host.layerData.set(providerId, entries);
}

function terminalJournal(runtime, runId) {
  return controlProjection(runtime.configService).prepared().configuration.upgrades
    .journal[runId];
}

function controlProvider(runtime) {
  const provider = runtime.configService.providers.find(
    (candidate) => candidate.id === "control",
  );
  assert.ok(provider?.authority);
  return provider;
}

async function commitDurableControl(runtime, mutate, restoreCache) {
  const host = hostForControl(runtime.configService);
  const provider = controlProvider(runtime);
  const cached = structuredClone(host.layerData.get(provider.id));
  const envelope = await provider.authority.readLayer(provider.layer);
  const state = structuredClone(envelope.entries._weaver);
  mutate(state);
  const { result } = await host.authority.commit(
    provider,
    provider.layer,
    "_weaver",
    state,
    false,
  );
  assert.equal(result.success, true);
  if (restoreCache) host.layerData.set(provider.id, cached);
}

async function writeSource(runtime) {
  assert.equal(
    (await runtime.configService.set("platform", "svc.keep", true)).success,
    true,
  );
}

async function recoverThreeTimes(runtime, runId) {
  const request = { version: 1, runId };
  return [
    await runtime.recoverUpgrade(request),
    await runtime.recoverUpgrade(request),
    await runtime.recoverUpgrade(request),
  ];
}

async function compensateAfterActivationFailure(t, runtime, request) {
  const control = runtime.configService.providers.find(
    (provider) => provider.id === "control",
  );
  const commit = control.authority.commitLayer.bind(control.authority);
  let failed = false;
  const fault = t.mock.method(
    control.authority,
    "commitLayer",
    async (candidate, handle) => {
      if (
        !failed &&
        candidate.mutation.action === "set" &&
        candidate.mutation.key === "_weaver"
      ) {
        failed = true;
        return {
          success: false,
          error: {
            code: "WRITE_ERROR",
            message: "injected activation failure",
          },
        };
      }
      return commit(candidate, handle);
    },
  );
  await assert.rejects(runtime.applyUpgrade({ version: 1, request }));
  const runId = runtime.maintenanceStatus().activeRun.runId;
  const compensated = await runtime.recoverUpgrade({
    version: 1,
    runId,
    action: "compensate",
    priorOwnerStopped: {
      observedAt: new Date().toISOString(),
      evidence: "same-process terminal recovery fixture",
    },
  });
  assert.equal(compensated.status, "compensated");
  fault.mock.restore();
  return runId;
}

function planRequest(runtime, initialization, target) {
  const sourceCatalog = {
    registrations: Object.fromEntries(
      initialization.registrations.map((request) => {
        const record = initialRegistrationRecord(request);
        return [internalRegistrationId(record), record];
      }),
    ),
  };
  const record = {
    version: 1,
    kind: "service",
    request: { ...initialization.registrations[0], schema: targetSchema },
    audit: { actor: "planner" },
  };
  const targetCatalog = {
    registrations: { [internalRegistrationId(record)]: record },
  };
  return {
    version: 1,
    expectedAuthorityRevision: runtime.configService.revision,
    sourceCatalogDigest: digest(sourceCatalog),
    inventoryRevision: "0",
    infrastructureGeneration: "g1",
    target: {
      catalogDigest: digest(targetCatalog),
      registrations: targetCatalog.registrations,
      ...(target === "builtin" || target === "combined"
        ? { builtinCatalog: BUILTIN_CATALOG_REFERENCE }
        : {}),
      ...(target === "infrastructure" || target === "combined"
        ? { infrastructureGeneration: "g1" }
        : {}),
    },
  };
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}
