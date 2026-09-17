import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  internalUpgradeLayerDigest,
  layerCommitRequestSchema,
} from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import { activationCompletionOperationId } from "../src/core/activation-completion-operation.ts";
import { hostForControl } from "../src/core/config-service-internal.ts";
import {
  createTwoProviderFixture,
  installTwoProviderPlan,
  journalFrom,
  rawState,
  seedTwoProviderSource,
  storeProtectedPlan,
  twoProviderRequest,
} from "./upgrade-two-provider-fixture.mjs";

test("U9.1 public apply resumes one installed two-provider filesystem plan exactly", async (t) => {
  const fixture = await createTwoProviderFixture();
  let runtime = await fixture.open();
  let closed = false;
  try {
    const installed = await installTwoProviderPlan(runtime, fixture);
    assert.equal(installed.plan.steps.length, 2);
    assert.equal(new Set(installed.plan.steps.map((step) => step.target.providerId)).size, 2);
    const partial = await executePartial(t, runtime, installed.request);
    await runtime.close();
    closed = true;
    runtime = await fixture.open();
    closed = false;
    await recoverExactly(t, runtime, partial, installed.plan);
  } finally {
    if (!closed) await runtime.close();
    await fixture.dispose();
  }
});

async function executePartial(t, runtime, request) {
  const runId = randomUUID();
  const before = await rawState(runtime);
  const secondary = provider(runtime, "secondary");
  const commit = secondary.authority.commitLayer.bind(secondary.authority);
  let faulted = false;
  const intercepted = t.mock.method(secondary.authority, "commitLayer", async (input, handle) => {
    const current = await rawState(runtime);
    const journal = journalFrom(current, runId);
    if (journal?.steps[0]?.status === "complete" &&
      journal.steps[1]?.status === "intent" &&
      journal.steps[1].operationId === input.operationId) {
      faulted = true;
      assert.equal(current.platform.lastCommit.operationId, journal.steps[0].operationId);
      assert.equal(current.secondary.sequence, before.secondary.sequence);
      throw new Error("fault before secondary durable effect");
    }
    return commit(input, handle);
  });
  try {
    await assert.rejects(runtime.applyUpgrade({ version: 1, runId, request }));
  } finally {
    intercepted.mock.restore();
  }
  assert.equal(faulted, true);
  const state = await rawState(runtime);
  assertPartialState(runtime, before, state, journalFrom(state, runId));
  return { runId, state, journal: journalFrom(state, runId) };
}

function assertPartialState(runtime, before, partial, journal) {
  assert.equal(runtime.state, "maintenance");
  assert.equal(journal.phase, "applying");
  assert.equal(journal.steps[0].status, "complete");
  assert.equal(journal.steps[0].receipt.operationId, journal.steps[0].operationId);
  assert.equal(journal.steps[0].receipt.mutationDigest, receiptDigest(journal.steps[0]));
  assert.deepEqual(journal.steps[0].receipt.previousRevision, revision(before.platform));
  assert.deepEqual(journal.steps[0].receipt.revision, revision(partial.platform));
  assert.equal(BigInt(partial.platform.sequence) - BigInt(before.platform.sequence), 1n);
  assert.deepEqual(partial.platform.lastCommit, journal.steps[0].receipt);
  assert.equal(journal.steps[1].status, "intent");
  assert.deepEqual(journal.steps[1].preRevision, revision(before.secondary));
  assert.equal(partial.secondary.sequence, before.secondary.sequence);
  assert.deepEqual(partial.secondary.lastCommit, before.secondary.lastCommit);
  assert.equal(partial.control.entries._weaver.format.initialization, "initialized");
}

async function recoverExactly(t, runtime, partial, plan) {
  const effects = observeRecoveryEffects(t, runtime, partial.journal);
  try {
    const recovered = await runtime.recoverUpgrade({
      version: 1,
      runId: partial.runId,
      priorOwnerStopped: {
        observedAt: new Date().toISOString(),
        evidence: "prior filesystem runtime closed",
      },
    });
    assert.equal(recovered.status, "completed");
    assert.equal(runtime.state, "ready");
    const final = await rawState(runtime);
    const completed = journalFrom(final, partial.runId);
    assert.equal(final.platform.sequence, partial.state.platform.sequence);
    assert.equal(BigInt(final.secondary.sequence) - BigInt(partial.state.secondary.sequence), 1n);
    assert.equal(completed.steps[1].status, "complete");
    assert.equal(final.secondary.lastCommit.operationId, partial.journal.steps[1].operationId);
    assert.equal(completed.steps[1].receipt.mutationDigest, receiptDigest(completed.steps[1]));
    assert.deepEqual(completed.steps[1].receipt.previousRevision, revision(partial.state.secondary));
    assert.deepEqual(completed.steps[1].receipt, final.secondary.lastCommit);
    assert.equal(completed.activation.status, "complete");
    assert.equal(completed.activation.receipt.operationId, completed.activation.operationId);
    assert.equal(final.control.lastCommit.operationId, activationCompletionOperationId(partial.runId));
    assert.deepEqual(final.control.lastCommit.previousRevision, completed.activation.receipt.revision);
    assert.deepEqual(effects.counts, { platform: 0, secondary: 1 });
    assertFinalDigests(final, plan);
    const terminal = await rawState(runtime);
    assert.equal((await runtime.recoverUpgrade({ version: 1, runId: partial.runId })).status, "completed");
    assert.deepEqual(effects.counts, { platform: 0, secondary: 1 });
    assert.deepEqual(await rawState(runtime), terminal);
  } finally {
    for (const mock of effects.mocks) mock.mock.restore();
  }
}

function observeRecoveryEffects(t, runtime, journal) {
  const counts = { platform: 0, secondary: 0 };
  const mocks = [];
  for (const id of ["platform", "secondary"]) {
    const authority = provider(runtime, id).authority;
    const commit = authority.commitLayer.bind(authority);
    mocks.push(t.mock.method(authority, "commitLayer", async (request, handle) => {
      if (request.operationId === journal.steps[0].operationId) counts.platform++;
      if (request.operationId === journal.steps[1].operationId) counts.secondary++;
      return commit(request, handle);
    }));
  }
  return { counts, mocks };
}

test("U9.1 stale installed-plan bindings reject before maintenance or writes", async () => {
  const fixture = await createTwoProviderFixture();
  const runtime = await fixture.open();
  try {
    const installed = await installTwoProviderPlan(runtime, fixture);
    for (const request of [
      { ...installed.request, expectedAuthorityRevision: "stale-authority" },
      { ...installed.request, inventoryRevision: "1" },
      { ...installed.request, infrastructureGeneration: "missing-generation" },
      { ...installed.request, sourceCatalogDigest: "0".repeat(64) },
    ]) {
      const before = await rawState(runtime);
      await assert.rejects(runtime.applyUpgrade({ version: 1, request }));
      assert.equal(runtime.state, "ready");
      assert.deepEqual(await rawState(runtime), before);
    }
    assert.equal((await runtime.configService.remove("secondary", "beta")).success, true);
    await runtime.configService.flush();
    const staleProvider = {
      ...installed.request,
      expectedAuthorityRevision: runtime.configService.revision,
    };
    const before = await rawState(runtime);
    await assert.rejects(runtime.applyUpgrade({ version: 1, request: staleProvider }));
    assert.equal(runtime.state, "ready");
    assert.deepEqual(await rawState(runtime), before);
  } finally {
    await runtime.close();
    await fixture.dispose();
  }
});

test("U9.1 ambiguous installed physical placements reject before maintenance", async () => {
  await withRuntime(async ({ runtime, fixture }) => {
    await installTwoProviderPlan(runtime, fixture);
    const second = await installTwoProviderPlan(runtime, fixture, {
      placements: ["secondary", "platform"],
    });
    const before = await rawState(runtime);
    await assert.rejects(runtime.applyUpgrade({ version: 1, request: second.request }));
    assert.equal(runtime.state, "ready");
    assert.deepEqual(await rawState(runtime), before);
  });
});

test("U9.1 canonical unrelated semantic mutation rejects before maintenance", async () => {
  await withRuntime(async ({ runtime, fixture }) => {
    const malicious = await installTwoProviderPlan(runtime, fixture, { malicious: true });
    const before = await rawState(runtime);
    await assert.rejects(runtime.applyUpgrade({ version: 1, request: malicious.request }));
    assert.equal(runtime.state, "ready");
    assert.deepEqual(await rawState(runtime), before);
  });
});

for (const [kind, option] of [
  ["malicious", { malicious: true }],
  ["stale", { stale: true }],
]) {
  for (const reverse of [false, true])
    test(`U9.1 valid plus ${kind} sibling rejects in ${reverse ? "reverse" : "forward"} order`, async () => {
      await withRuntime(async ({ runtime, fixture }) => {
        const order = reverse ? [option, {}] : [{}, option];
        let request;
        const planIds = [];
        for (const settings of order) {
          const installed = await installTwoProviderPlan(runtime, fixture, settings);
          request = installed.request;
          planIds.push(installed.plan.id);
        }
        const before = await rawState(runtime);
        const error = await rejection(runtime.applyUpgrade({ version: 1, request }));
        const fingerprint = { code: error.code, message: error.message };
        const previous = candidateErrors.get(kind);
        if (previous) assert.deepEqual(fingerprint, previous);
        else candidateErrors.set(kind, fingerprint);
        for (const planId of planIds)
          assert.equal(JSON.stringify(error).includes(planId), false);
        assert.equal(runtime.state, "ready");
        assert.deepEqual(await rawState(runtime), before);
      });
    });
}

const candidateErrors = new Map();

test("U9.1 malformed protected plan is rejected by strict storage", async () => {
  await withRuntime(async ({ runtime, fixture }) => {
    const installed = await installTwoProviderPlan(runtime, fixture);
    const before = await rawState(runtime);
    await assert.rejects(storeProtectedPlan(runtime, { ...installed.plan, id: "0".repeat(64) }));
    assert.equal(runtime.state, "ready");
    assert.deepEqual(await rawState(runtime), before);
  });
});

test("U9.1 true zero installed candidate preserves automatic planning", async () => {
  await withRuntime(async ({ runtime, fixture }) => {
    await seedTwoProviderSource(runtime);
    const request = twoProviderRequest(runtime, fixture.request);
    const result = await runtime.applyUpgrade({ version: 1, request });
    assert.equal(result.status, "completed");
    assert.equal(runtime.state, "ready");
  });
});

test("U9.1 later-provider race stops before first planned data mutation", async (t) => {
  await withRuntime(async ({ runtime, fixture }) => {
    const installed = await installTwoProviderPlan(runtime, fixture);
    const runId = randomUUID();
    const before = await rawState(runtime);
    const secondary = provider(runtime, "secondary");
    const control = provider(runtime, "control");
    const host = hostForControl(runtime.configService);
    const inventory = secondary.authority.inventory.bind(secondary.authority);
    let competed = false;
    const intercepted = t.mock.method(secondary.authority, "inventory", async () => {
      const current = await control.authority.readLayer(control.layer);
      const journal = journalFrom({ control: current }, runId);
      if (!competed && journal?.steps[0]?.status === "intent") {
        competed = true;
        const result = await host.authority.commit(
          secondary,
          "secondary",
          "beta",
          { keep: true, competitor: true },
          false,
          randomUUID(),
        );
        assert.equal(result.result.success, true);
      }
      return inventory();
    });
    try {
      await assert.rejects(runtime.applyUpgrade({ version: 1, runId, request: installed.request }));
    } finally {
      intercepted.mock.restore();
    }
    await assertRaceState(runtime, before, runId, competed);
  });
});

for (const competitor of ["definition", "unrelated"]) {
  test(`U9.1 ${competitor} control commit after intent stops planned data`, async (t) => {
    await withRuntime(async ({ runtime, fixture }) => {
      const installed = await installTwoProviderPlan(runtime, fixture);
      const runId = randomUUID();
      const before = await rawState(runtime);
      const control = provider(runtime, "control");
      const host = hostForControl(runtime.configService);
      const events = [];
      const unsubscribe = runtime.configService.onDelta((event) => events.push(event));
      const readLayer = control.authority.readLayer.bind(control.authority);
      let competed = false;
      const intercepted = t.mock.method(control.authority, "readLayer", async (...args) => {
        const current = await readLayer(...args);
        const journal = journalFrom({ control: current }, runId);
        if (competed || journal?.steps[0]?.status !== "intent") return current;
        competed = true;
        const { key, value } = competingControlMutation(current, competitor);
        const result = await host.authority.commit(
          control,
          control.layer,
          key,
          value,
          false,
          randomUUID(),
        );
        assert.equal(result.result.success, true);
        return readLayer(...args);
      });
      try {
        await assert.rejects(runtime.applyUpgrade({ version: 1, runId, request: installed.request }));
      } finally {
        intercepted.mock.restore();
        unsubscribe();
      }
      await assertControlRaceState(runtime, before, runId, competed, events);
    });
  });
}

function competingControlMutation(envelope, competitor) {
  if (competitor === "unrelated")
    return { key: "_weaver.scopeInventory.revision", value: "1" };
  const providers = structuredClone(
    envelope.entries._weaver.infrastructure.generations.g1.providers,
  );
  const secondary = providers.find((item) => item.id === "secondary");
  assert.ok(secondary);
  secondary.options = {
    ...secondary.options,
    filePath: `${secondary.options.filePath}.competing`,
  };
  return { key: "_weaver.infrastructure.generations.g1.providers", value: providers };
}

async function assertControlRaceState(runtime, before, runId, competed, events) {
  const raced = await rawState(runtime);
  const journal = journalFrom(raced, runId);
  assert.equal(competed, true);
  assert.equal(runtime.state, "maintenance");
  assert.equal(journal.steps[0].status, "intent");
  assert.equal(raced.platform.sequence, before.platform.sequence);
  assert.equal(raced.secondary.sequence, before.secondary.sequence);
  assert.equal(BigInt(raced.control.sequence) - BigInt(before.control.sequence), 3n);
  assert.equal(journal.activation.status, "pending");
  assert.deepEqual(events, []);
  await assert.rejects(runtime.configService.get("alpha"), { code: "MAINTENANCE" });
  const stable = await rawState(runtime);
  await assert.rejects(runtime.recoverUpgrade({ version: 1, runId }));
  assert.deepEqual(await rawState(runtime), stable);
}

async function rejection(operation) {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  assert.fail("Expected rejection");
}

async function assertRaceState(runtime, before, runId, competed) {
  const raced = await rawState(runtime);
  const journal = journalFrom(raced, runId);
  assert.equal(competed, true);
  assert.equal(runtime.state, "maintenance");
  assert.equal(journal.steps[0].status, "intent");
  assert.equal(raced.platform.sequence, before.platform.sequence);
  assert.equal(BigInt(raced.secondary.sequence) - BigInt(before.secondary.sequence), 1n);
  assert.equal(journal.activation.status, "pending");
  const stable = await rawState(runtime);
  await assert.rejects(runtime.recoverUpgrade({ version: 1, runId }));
  assert.deepEqual(await rawState(runtime), stable);
}

async function withRuntime(operation) {
  const fixture = await createTwoProviderFixture();
  const runtime = await fixture.open();
  try {
    await operation({ fixture, runtime });
  } finally {
    await runtime.close();
    await fixture.dispose();
  }
}

function receiptDigest(step) {
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  return computeProviderMutationDigest(layerCommitRequestSchema.parse({
    layer: step.target.layer,
    expectedRevision: step.receipt.previousRevision,
    operationId: step.operationId,
    mutation: step.mutation.action === "set"
      ? { action: "set", key, value: step.mutation.value }
      : { action: "remove", key },
  }));
}

function assertFinalDigests(state, plan) {
  for (const binding of plan.finalLayers) {
    const envelope = state[binding.providerId];
    assert.ok(envelope);
    assert.equal(
      internalUpgradeLayerDigest(envelope.entries, binding.contentDomain),
      binding.finalDigest,
    );
  }
}

function provider(runtime, id) {
  const result = hostForControl(runtime.configService).providers.find((item) => item.id === id);
  assert.ok(result?.authority);
  return result;
}

function revision(envelope) {
  return {
    storeId: envelope.storeId,
    environment: envelope.environment,
    layer: envelope.layer,
    epoch: envelope.epoch,
    sequence: envelope.sequence,
  };
}
