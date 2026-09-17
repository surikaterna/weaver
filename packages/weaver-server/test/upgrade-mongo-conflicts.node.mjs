import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { layerCommitRequestSchema } from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import {
  assertPublicSecretSafe,
  createMongoUpgradeFixture,
  journal,
  observeMongoDataWrites,
  publicRejection,
  revision,
  withoutId,
} from "./upgrade-mongo-fixture.mjs";

for (const applied of [false, true]) {
  const kind = applied
    ? "committed effect before caller observed response"
    : "pre-effect uncertainty";
  test(`U9.3 ${kind} reconciles only after close and reopen`, async () => {
    await runUncertainty(applied);
  });
}

async function runUncertainty(applied) {
  const fixture = await createMongoUpgradeFixture();
  let runtime = await fixture.open();
  try {
    const installed = await fixture.prepare(runtime);
    const runId = randomUUID();
    const before = await fixture.snapshot();
    const attempt = await createUncertainty(
      fixture, runtime, installed.request, runId, before, applied,
    );
    await runtime.close();
    runtime = await fixture.open();
    await recoverUncertainty(
      fixture, runtime, runId, before, attempt.operationId, applied,
    );
  } finally {
    await runtime.close();
    await fixture.dispose();
  }
}

async function createUncertainty(fixture, runtime, request, runId, before, applied) {
  const observer = observeMongoDataWrites(
    fixture,
    runId,
    uncertainInterceptor(applied),
  );
  try {
    const error = await publicRejection(runtime.applyUpgrade({
      version: 1,
      runId,
      request,
    }));
    assert.equal(error.code, "COMMIT_OUTCOME_UNKNOWN");
    assert.equal(error.details.maintenanceCode, "unknown-commit");
    assert.equal(error.details.category, "uncertainty");
    assertPublicSecretSafe(error, fixture, ["raw-provider-secret-response-loss"]);
    const partial = await fixture.snapshot();
    assertUncertain(partial, before, runId, applied);
    assert.equal(observer.attemptedOperationIds.length, 1);
    assert.equal(observer.operationIds.length, applied ? 1 : 0);
    await assertSameAuthorityRefusal(fixture, runtime);
    return { operationId: observer.attemptedOperationIds[0] };
  } finally {
    observer.restore();
  }
}

function uncertainInterceptor(applied) {
  return async ({ collection, args, original, markCommitted }) => {
    if (applied) {
      const result = await original.apply(collection, args);
      assert.equal(result.acknowledged, true);
      assert.equal(result.matchedCount, 1);
      markCommitted();
    }
    throw new Error("raw-provider-secret-response-loss");
  };
}

async function assertSameAuthorityRefusal(fixture, runtime) {
  assert.equal(runtime.state, "maintenance");
  await assert.rejects(runtime.configService.get("alpha"), {
    code: "MAINTENANCE",
  });
  const stable = await fixture.snapshot();
  const refused = await runtime.configService.set("secondary", "alpha", {});
  assert.equal(refused.success, false);
  assert.equal(refused.error.code, "MAINTENANCE");
  assertMongoState(await fixture.snapshot(), stable);
}

async function recoverUncertainty(
  fixture, runtime, runId, before, operationId, applied,
) {
  const observer = observeMongoDataWrites(fixture, runId);
  try {
    const result = await runtime.recoverUpgrade({
      version: 1,
      runId,
      priorOwnerStopped: stoppedEvidence(),
    });
    assert.equal(result.status, "completed");
    assert.equal(runtime.state, "ready");
    assert.equal(observer.operationIds.length, applied ? 0 : 1);
    assert.equal(
      observer.attemptedOperationIds[0],
      applied ? undefined : operationId,
    );
    const final = await fixture.snapshot();
    assert.equal(journal(final, runId).activation.status, "complete");
    assert.equal(BigInt(final.mongo.sequence) - BigInt(before.mongo.sequence), 1n);
  } finally {
    observer.restore();
  }
}

test("U9.3 genuine Mongo revision conflict preserves the competitor", async () => {
  await runConflict("revision", async ({ collection, args, original, before }) => {
    const operationId = randomUUID();
    const previousRevision = revision(before.mongo);
    const nextRevision = {
      ...previousRevision,
      sequence: String(BigInt(previousRevision.sequence) + 1n),
    };
    const request = layerCommitRequestSchema.parse({
      layer: "secondary",
      expectedRevision: previousRevision,
      operationId,
      mutation: { action: "set", key: "competitor", value: true },
    });
    const envelope = {
      ...withoutId(before.mongo),
      entries: { ...before.mongo.entries, competitor: true },
      sequence: nextRevision.sequence,
      lastCommit: {
        operationId,
        previousRevision,
        revision: nextRevision,
        mutationDigest: computeProviderMutationDigest(request),
      },
    };
    const won = await original.call(
      collection,
      args[0],
      { $set: envelope },
      args[2],
    );
    assert.equal(won.matchedCount, 1);
    return original.apply(collection, args);
  });
});

test("U9.3 Mongo fence loss prevents overwrite and ownership release", async () => {
  await runConflict("fence", async ({ collection, args, original }) => {
    const lost = await original.call(
      collection,
      args[0],
      { $set: { owner: randomUUID(), fence: "999" } },
      args[2],
    );
    assert.equal(lost.matchedCount, 1);
    return original.apply(collection, args);
  });
});

async function runConflict(kind, inject) {
  const fixture = await createMongoUpgradeFixture();
  const runtime = await fixture.open();
  let observer;
  let primary;
  try {
    const installed = await fixture.prepare(runtime);
    const runId = randomUUID();
    const before = await fixture.snapshot();
    observer = observeMongoDataWrites(fixture, runId, (context) =>
      inject({ ...context, before }));
    primary = await publicRejection(runtime.applyUpgrade({
      version: 1,
      runId,
      request: installed.request,
    }));
    observer.restore();
    observer = undefined;
    assert.equal(primary.code, "REVISION_CONFLICT");
    assert.equal(primary.details.maintenanceCode, "stale-plan");
    assertPublicSecretSafe(primary, fixture);
    const conflicted = await fixture.snapshot();
    assertConflictState(conflicted, before, runId, kind);
    const stable = await fixture.snapshot();
    const recoveryError = await publicRejection(
      runtime.recoverUpgrade({ version: 1, runId }),
    );
    assert.equal(recoveryError.code, "REVISION_CONFLICT");
    const afterRecovery = await fixture.snapshot();
    assert.deepEqual(afterRecovery.mongo, stable.mongo);
    assert.equal(journal(afterRecovery, runId).activation.status, "pending");
  } finally {
    observer?.restore();
    try {
      await runtime.close();
    } catch (closeError) {
      if (!primary) throw closeError;
      assert.ok(closeError instanceof Error);
    }
    await fixture.dispose();
  }
}

function assertConflictState(conflicted, before, runId, kind) {
  const recorded = journal(conflicted, runId);
  assert.equal(recorded.steps.at(-1).status, "intent");
  assert.equal(recorded.activation.status, "pending");
  assert.notEqual(
    conflicted.mongo.lastCommit.operationId,
    recorded.steps.at(-1).operationId,
  );
  assert.equal(
    BigInt(conflicted.mongo.sequence) - BigInt(before.mongo.sequence),
    kind === "revision" ? 1n : 0n,
  );
  if (kind !== "fence") return;
  assert.deepEqual(conflicted.mongo.entries, before.mongo.entries);
  assert.deepEqual(conflicted.mongo.lastCommit, before.mongo.lastCommit);
}

function assertUncertain(partial, before, runId, applied) {
  const recorded = journal(partial, runId);
  assert.equal(recorded.phase, "applying");
  assert.equal(recorded.steps.at(-1).status, "intent");
  assert.equal(recorded.activation.status, "pending");
  assert.equal(
    BigInt(partial.mongo.sequence) - BigInt(before.mongo.sequence),
    applied ? 1n : 0n,
  );
  if (applied)
    assert.equal(
      partial.mongo.lastCommit.operationId,
      recorded.steps.at(-1).operationId,
    );
  else assertMongoState(partial, before);
}

function assertMongoState(left, right) {
  assert.deepEqual(left.mongoBytes, right.mongoBytes);
  assert.deepEqual(left.mongoCanonical, right.mongoCanonical);
}

function stoppedEvidence() {
  return {
    observedAt: new Date().toISOString(),
    evidence: "uncertain authority closed before exact recovery",
  };
}
