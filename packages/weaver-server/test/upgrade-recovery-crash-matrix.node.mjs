import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import { internalUpgradeLayerDigest } from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import {
  crashRows,
  observeAdmission,
  rawState,
  revisionDelta,
  withCrashRuntime,
} from "./upgrade-recovery-matrix-fixture.mjs";

for (const row of [
  ...crashRows,
  { name: "builtin-verifying", fault: "activation-intent", initial: "verifying",
    target: "builtin" },
  { name: "infrastructure-activation", fault: "activation-completion", initial: "verifying",
    target: "infrastructure" },
])
  test(`repeated recovery is exact at ${row.name}`, async (t) => {
    await withCrashRuntime(t, row, async ({ runtime, request, effects, checkpoint, reopen }) => {
      await assert.rejects(runtime.applyUpgrade({ version: 1, request }));
      const crashed = await rawState(runtime);
      assert.equal(crashed.journal.phase, row.initial);
      assert.equal(crashed.journal.steps[0].status, initialStepStatus(row.fault));
      assert.equal(crashed.journal.activation.status,
        row.fault === "activation-completion" ? "intent" : "pending");
      assert.equal(runtime.maintenanceStatus().ready, false);
      const dataOperation = crashed.journal.steps[0].operationId;
      const runId = crashed.journal.runId;
      const plan = crashed.authorities.control.entries._weaver.upgrades.plans[
        crashed.journal.planId];
      const recoveredRuntime = await reopen();
      const admission = observeAdmission(t, recoveredRuntime);
      const beforeRecovery = await rawState(recoveredRuntime);
      const beforeRecords = effects.checkpoint();
      const recovery = recoveryRequest(runId);
      const first = await recoveredRuntime.recoverUpgrade(recovery);
      const afterFirst = await rawState(recoveredRuntime);
      const firstRecords = effects.records(beforeRecords);
      assertTerminalEvidence(plan, afterFirst);
      admission.close();
      const secondRuntime = await reopen();
      const secondAdmission = observeAdmission(t, secondRuntime);
      const beforeSecondState = await rawState(secondRuntime);
      const beforeSecond = effects.checkpoint();
      const second = await secondRuntime.recoverUpgrade(recovery);
      const afterSecond = await rawState(secondRuntime);
      assert.deepEqual(afterSecond, afterFirst);
      assert.deepEqual(beforeSecondState, afterFirst);
      assert.deepEqual(effects.records(beforeSecond), []);
      assertTerminalEvidence(plan, afterSecond);
      assert.equal(first.status, row.target ? "restart-required" : "completed");
      assert.equal(second.status, first.status);
      assert.equal(afterFirst.journal.phase, first.status);
      assert.ok(afterFirst.journal.steps.every((step) => step.status === "complete"));
      assert.equal(afterFirst.journal.steps[0].receipt.operationId, dataOperation);
      const allRecords = effects.records(checkpoint);
      assert.deepEqual(allRecords.map((record) => record.kind), expectedSequence(row));
      assert.equal(count(allRecords, "data"), 1);
      assert.equal(count(allRecords, "activation-CAS"), 1);
      assert.equal(count(allRecords, "activation-completion"), 1);
      assert.equal(count(allRecords, "blocked"), 0);
      assert.equal(revisionDelta(beforeRecovery, afterFirst, "platform"),
        ["applying", "intent", "data"].includes(row.fault) &&
          row.mode !== "commit-then-reject" ? 1n : 0n);
      assert.equal(revisionDelta(beforeRecovery, afterFirst, "control"),
        expectedRecoveryControlDelta(row));
      const admissions = admission.snapshot();
      assert.deepEqual(admissions, row.target
        ? { installs: 0, opens: 0, resumes: 0, publications: 0 }
        : { installs: 1, opens: 1, resumes: 1, publications: 0 });
      assert.deepEqual(secondAdmission.snapshot(),
        { installs: 0, opens: 0, resumes: 0, publications: 0 });
      assert.equal(secondRuntime.state, row.target ? "restart_required" : "ready");
      assert.equal(firstRecords.filter((item) => item.kind === "data").length,
        row.name === "prepared" || row.name === "intent" || row.name === "predata" ? 1 : 0);
      secondAdmission.close();
    });
  });

function recoveryRequest(runId) {
  return {
    version: 1,
    runId,
    priorOwnerStopped: {
      observedAt: new Date().toISOString(),
      evidence: "faulted FS runtime was closed before recovery",
    },
  };
}

function count(records, kind) {
  return records.filter((record) => record.kind === kind).length;
}

function initialStepStatus(fault) {
  if (["applying", "intent"].includes(fault)) return "pending";
  if (fault === "data") return "intent";
  return "complete";
}

function expectedSequence(row) {
  const prefixes = {
    applying: ["plan", "prepared"],
    intent: ["plan", "prepared", "applying"],
    data: ["plan", "prepared", "applying", "intent"],
    completion: ["plan", "prepared", "applying", "intent", "data"],
    verifying: ["plan", "prepared", "applying", "intent", "data", "completion"],
    "activation-intent": ["plan", "prepared", "applying", "intent", "data",
      "completion", "verifying"],
    "activation-completion": ["plan", "prepared", "applying", "intent", "data",
      "completion", "verifying", "activation-intent", "activation-CAS"],
  };
  if (row.fault === "data" && row.mode === "commit-then-reject")
    prefixes.data = [...prefixes.data, "data"];
  const adoption = {
    applying: "prepared",
    intent: "applying",
    data: "intent",
    completion: "intent",
    verifying: "completion",
    "activation-intent": "verifying",
    "activation-completion": "activation-intent",
  }[row.fault];
  const suffixes = {
    applying: ["intent", "data", "completion", "verifying"],
    intent: ["intent", "data", "completion", "verifying"],
    data: row.mode === "commit-then-reject"
      ? ["completion", "verifying"] : ["data", "completion", "verifying"],
    completion: ["completion", "verifying"],
    verifying: ["verifying"],
    "activation-intent": [],
    "activation-completion": [],
  }[row.fault];
  return [...prefixes[row.fault],
    ...(row.fault === "activation-completion" ? [] : [adoption]), ...suffixes,
    ...(row.fault === "activation-completion" ? [] : ["activation-intent", "activation-CAS"]),
    "activation-completion"];
}

function expectedRecoveryControlDelta(row) {
  return {
    applying: 7n,
    intent: 7n,
    data: 6n,
    completion: 6n,
    verifying: 5n,
    "activation-intent": 4n,
    "activation-completion": 1n,
  }[row.fault];
}

function assertTerminalEvidence(plan, state) {
  const journal = state.journal;
  assert.deepEqual(journal.sourceRevisions, plan.source.providerRevisions.flatMap(
    (provider) => provider.revisions.map((revision) =>
      ({ providerId: provider.providerId, revision }))));
  assert.equal(journal.steps.length, plan.steps.length);
  for (const [index, recorded] of journal.steps.entries()) {
    const planned = plan.steps[index];
    assert.equal(recorded.id, planned.id);
    assert.deepEqual(recorded.target, planned.target);
    assert.equal(recorded.preDigest, planned.preDigest);
    assert.equal(recorded.postDigest, planned.postDigest);
    assert.deepEqual(recorded.mutation, planned.mutation);
    assert.deepEqual(recorded.receipt.previousRevision, recorded.preRevision);
    assert.equal(recorded.receipt.operationId, recorded.operationId);
    assert.equal(recorded.receipt.mutationDigest, mutationDigest(recorded));
    const cursor = journal.cursor.find((entry) =>
      entry.providerId === recorded.target.providerId &&
      entry.revision.layer === recorded.target.layer);
    assert.deepEqual(cursor.revision, recorded.receipt.revision);
    assert.deepEqual(revision(state.authorities[recorded.target.providerId]), cursor.revision);
  }
  for (const binding of plan.finalLayers) {
    const envelope = state.authorities[binding.providerId];
    assert.equal(internalUpgradeLayerDigest(envelope.entries, binding.contentDomain),
      binding.finalDigest);
    const evidence = journal.activation.finalContexts.layers.find((item) =>
      item.providerId === binding.providerId && item.revision.layer === binding.layer);
    if (binding.providerId === "control") {
      assert.deepEqual({ ...evidence.revision, sequence: envelope.sequence },
        revision(envelope));
      assert.ok(BigInt(evidence.revision.sequence) < BigInt(envelope.sequence));
    } else assert.deepEqual(evidence.revision, revision(envelope));
    assert.equal(evidence.contentDigest, binding.finalDigest);
  }
}

function mutationDigest(step) {
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  return computeProviderMutationDigest({
    layer: step.target.layer,
    expectedRevision: step.receipt.previousRevision,
    operationId: step.operationId,
    mutation: step.mutation.action === "set"
      ? { action: "set", key, value: step.mutation.value }
      : { action: "remove", key },
  });
}

function revision(envelope) {
  const { storeId, environment, layer, epoch, sequence } = envelope;
  return { storeId, environment, layer, epoch, sequence };
}
