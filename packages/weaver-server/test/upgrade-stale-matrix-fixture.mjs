import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  canonicalInternalJson,
  internalConfigurationSchema,
} from "@weaver-conf/config-types";
import {
  observeAdmission,
  withStaleCheckpoint,
} from "./upgrade-recovery-matrix-fixture.mjs";

export async function assertStaleRow(t, row) {
  const mutate = (envelope, runId) => {
    row.mutate(envelope, runId);
    if (!row.schemaInvalid)
      internalConfigurationSchema.parse(envelope.entries._weaver);
  };
  await withStaleCheckpoint(t, row.phase ?? "verifying", mutate,
    async ({ runtime, openError, openAgain, reopenRuntime, effects, checkpoint,
      raw, path, runId }) => {
      if (openError) {
        const repeated = await openAgain();
        assert.ok(repeated);
        assert.equal(repeated.code, openError.code);
        assert.equal(repeated.message, openError.message);
        assert.equal(await readFile(path, "utf8"), raw);
        assert.deepEqual(effects.records(checkpoint), []);
        return;
      }
      assert.equal(row.schemaInvalid, false);
      assert.ifError(openError);
      assert.ok(runtime);
      const failures = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const admission = observeAdmission(t, runtime);
        const before = effects.checkpoint();
        try {
          await runtime.recoverUpgrade(recoveryRequest(runId));
          assert.fail("stale recovery unexpectedly succeeded");
        } catch (error) {
          failures.push({ code: error.code, message: error.message });
        }
        assert.deepEqual(effects.records(before), []);
        assert.deepEqual(admission.snapshot(),
          { installs: 0, opens: 0, resumes: 0, publications: 0 });
        admission.close();
        if (attempt === 0) runtime = await reopenRuntime();
      }
      assert.equal(failures[0].code, failures[1].code);
      assert.equal(failures[0].message, failures[1].message);
      assert.ok(["VALIDATION_ERROR", "REVISION_CONFLICT", "UNSUPPORTED_AUTHORITY"]
        .includes(failures[0].code));
      assert.equal(runtime.maintenanceStatus().ready, false);
      assert.notEqual(runtime.state, "ready");
      assert.deepEqual(effects.records(checkpoint), []);
      assert.equal(await readFile(path, "utf8"), raw);
    });
}

export function controlState(envelope) {
  return envelope.entries._weaver;
}

export function selected(envelope, runId) {
  const state = controlState(envelope);
  const journal = state.upgrades.journal[runId];
  return { state, journal, plan: state.upgrades.plans[journal.planId] };
}

export function replacePlan(envelope, runId, mutate) {
  const { state, journal, plan } = selected(envelope, runId);
  const changed = structuredClone(plan);
  mutate(changed, journal);
  const { id: _id, ...body } = changed;
  changed.id = digest(body);
  delete state.upgrades.plans[plan.id];
  state.upgrades.plans[changed.id] = changed;
  journal.planId = changed.id;
  return { state, journal, plan: changed };
}

export function zeroDigest() {
  return "0".repeat(64);
}

export function forgedId() {
  return "forged-authority";
}

export function digestValue(value) {
  return digest(value);
}

function recoveryRequest(runId) {
  return {
    version: 1,
    runId,
    priorOwnerStopped: {
      observedAt: new Date().toISOString(),
      evidence: "stale matrix predecessor was closed",
    },
  };
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}
