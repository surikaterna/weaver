import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  canonicalInternalJson,
  internalConfigurationSchema,
  internalRegistrationId,
} from "@weaver-conf/config-types";
import * as publicApi from "../src/index.ts";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import {
  consumePinnedRecoveryContext,
  inspectPinnedRecovery,
} from "../src/bootstrap/pinned-recovery-open.ts";
import {
  createBuiltinProviderFactories,
  disposeProviderResources,
} from "../src/bootstrap/provider-resources.ts";
import { createSeedResource } from "../src/bootstrap/seed-resource.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { readBuiltinRecoveryEnvelope } from "../src/core/builtin-catalog.ts";
import {
  assertPreservationCoverage,
  assertPreservedControl,
  expectedCompletedEnvelope,
  preservationSnapshot,
} from "./pinned-recovery-preservation.mjs";
import { createStandaloneFixture } from "./standalone-fixture.ts";
import { rawRuntimeProviders } from "./upgrade-test-providers.mjs";
import { durableReplace } from "./upgrade-final-matrix-fixture.mjs";

const sourceSchema = {
  type: "object",
  properties: { keep: { type: "boolean" } },
  additionalProperties: false,
};
const targetSchema = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    added: { type: "string", default: "recovered" },
  },
  additionalProperties: false,
};

test("public factories do not expose injectable pinned recovery inputs", async () => {
  assert.equal(publicApi.createWeaverConfigService.length, 1);
  assert.equal(publicApi.createControlService.length, 1);
  assert.equal("createPinnedWeaverConfigService" in publicApi, false);
  assert.equal("createPinnedControlService" in publicApi, false);
  await assert.rejects(consumePinnedRecoveryContext({}, []), {
    code: "VALIDATION_ERROR",
  });
});

test("pinned provenance rejects a control change after inspection", async (t) => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let resource;
  try {
    await leavePreparedRun(t, fixture);
    const before = await controlFile(fixture);
    before.entries._weaver.format.builtinCatalog.digest = "0".repeat(64);
    await durableReplace(fixture.seed.store.locator.filePath, before);
    resource = await createSeedResource(
      fixture.seed,
      fixture.credentials,
      createBuiltinProviderFactories(),
      false,
    );
    const pinned = await inspectPinnedRecovery(fixture.seed, resource);
    assert.ok(pinned);
    const changed = await controlFile(fixture);
    changed.entries._weaver.scopeInventory.revision = "concurrent-change";
    await durableReplace(fixture.seed.store.locator.filePath, changed);
    await assert.rejects(
      consumePinnedRecoveryContext(pinned, [resource.provider]),
      { code: "VALIDATION_ERROR" },
    );
  } finally {
    if (resource) await disposeProviderResources([resource]);
    await fixture.dispose();
  }
});

test("pinned startup preserves complete unrelated control state across repeated recovery", async (t) => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let recovered;
  try {
    const runId = await leavePreparedRun(t, fixture);
    const before = await controlFile(fixture);
    const preservation = await installAdversarialState(fixture, before, runId);
    const { baseline, expected, selectedPlanId } = preservation;
    recovered = await openWeaverRuntime(fixture.seed, {
      credentials: fixture.credentials,
    });
    await assertFirstRecovery(
      fixture,
      recovered,
      runId,
      baseline,
      expected,
      selectedPlanId,
    );
    await recovered.close();
    recovered = await openWeaverRuntime(fixture.seed, {
      credentials: fixture.credentials,
    });
    assert.equal(recovered.state, "ready");
    assert.equal(
      (await recovered.recoverUpgrade({ version: 1, runId })).status,
      "completed",
    );
    assertPreservedControl(
      await controlFile(fixture),
      baseline,
      expected,
      selectedPlanId,
      runId,
      "repeated terminal recovery",
    );
  } finally {
    await recovered?.close();
    await fixture.dispose();
  }
});

test("a broken ordinary target without a journal remains rejected and unchanged", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  try {
    await initializeWeaver(
      fixture.seed,
      fixture.request,
      fixture.administrator,
      { credentials: fixture.credentials },
    );
    const broken = await controlFile(fixture);
    broken.entries._weaver.format.builtinCatalog.digest = "0".repeat(64);
    await durableReplace(fixture.seed.store.locator.filePath, broken);
    const serialized = await readFile(fixture.seed.store.locator.filePath, "utf8");
    await assert.rejects(
      openWeaverRuntime(fixture.seed, { credentials: fixture.credentials }),
    );
    assert.equal(
      await readFile(fixture.seed.store.locator.filePath, "utf8"),
      serialized,
    );
  } finally {
    await fixture.dispose();
  }
});

test("malformed pinned layer evidence is a sanitized validation stop", async (t) => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  try {
    const runId = await leavePreparedRun(t, fixture);
    const broken = await controlFile(fixture);
    broken.entries._weaver.format.builtinCatalog.digest = "0".repeat(64);
    const journal = broken.entries._weaver.upgrades.journal[runId];
    journal.steps[0].target.storeId = "forged-store";
    await durableReplace(fixture.seed.store.locator.filePath, broken);
    await assert.rejects(
      openWeaverRuntime(fixture.seed, { credentials: fixture.credentials }),
      (error) => {
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(
          error.message,
          /Pinned recovery evidence is malformed, unsupported, or divergent/,
        );
        assert.equal(JSON.stringify(error).includes("forged-store"), false);
        assert.equal(JSON.stringify(error).includes("Zod"), false);
        return true;
      },
    );
  } finally {
    await fixture.dispose();
  }
});

async function leavePreparedRun(t, fixture) {
  await initializeWeaver(
    fixture.seed,
    fixture.request,
    fixture.administrator,
    { credentials: fixture.credentials },
  );
  const runtime = await openWeaverRuntime(fixture.seed, {
    credentials: fixture.credentials,
  });
  assert.equal(
    (await runtime.configService.set("platform", "svc.keep", true)).success,
    true,
  );
  const control = rawRuntimeProviders(runtime).find(
    (provider) => provider.id === "control",
  );
  const commit = control.authority.commitLayer.bind(control.authority);
  t.mock.method(control.authority, "commitLayer", async (request, handle) => {
    if (
      request.mutation.action === "set" &&
      request.mutation.value?.phase === "applying"
    )
      return {
        success: false,
        error: { code: "WRITE_ERROR", message: "prepared crash" },
      };
    return commit(request, handle);
  });
  await assert.rejects(
    runtime.applyUpgrade({
      version: 1,
      request: planRequest(runtime, fixture.request),
    }),
  );
  const runId = runtime.maintenanceStatus().activeRun.runId;
  t.mock.restoreAll();
  await runtime.close();
  return runId;
}

function planRequest(runtime, initialization) {
  const source = catalog(initialization, sourceSchema);
  const target = catalog(initialization, targetSchema);
  return {
    version: 1,
    expectedAuthorityRevision: runtime.configService.revision,
    sourceCatalogDigest: digest(source),
    inventoryRevision: "0",
    infrastructureGeneration: "g1",
    target: {
      catalogDigest: digest(target),
      registrations: target.registrations,
    },
  };
}

function catalog(initialization, schema) {
  const record = initialRegistrationRecord({
    ...initialization.registrations[0],
    schema,
  });
  return { registrations: { [internalRegistrationId(record)]: record } };
}

function digest(value) {
  return createHash("sha256")
    .update(canonicalInternalJson(value))
    .digest("hex");
}

function stoppedEvidence() {
  return {
    observedAt: new Date().toISOString(),
    evidence: "fresh process opened the exact durable recovery run",
  };
}

function controlFile(fixture) {
  return readFile(fixture.seed.store.locator.filePath, "utf8").then(JSON.parse);
}

async function assertFirstRecovery(
  fixture,
  recovered,
  runId,
  baseline,
  expected,
  selectedPlanId,
) {
  assert.equal(recovered.state, "maintenance");
  await assert.rejects(recovered.configService.get("svc"), {
    code: "CONFIG_NOT_READY",
  });
  const result = await recovered.recoverUpgrade({
    version: 1,
    runId,
    priorOwnerStopped: stoppedEvidence(),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.effects.completedSteps, 1);
  assert.equal(recovered.state, "ready");
  assert.deepEqual(await recovered.configService.get("svc"), {
    keep: true,
    added: "recovered",
  });
  assertPreservedControl(
    await controlFile(fixture),
    baseline,
    expected,
    selectedPlanId,
    runId,
    "first recovery",
  );
}

async function installAdversarialState(fixture, envelope, runId) {
  const unrelated = addUnrelatedRecords(envelope.entries._weaver);
  envelope.entries._weaver.format.builtinCatalog.digest = "0".repeat(64);
  internalConfigurationSchema.parse(envelope.entries._weaver);
  for (const journal of Object.values(envelope.entries._weaver.upgrades.journal))
    readBuiltinRecoveryEnvelope(journal);
  await durableReplace(fixture.seed.store.locator.filePath, envelope);
  const baseline = structuredClone(await controlFile(fixture));
  const selectedPlanId = baseline.entries._weaver.upgrades.journal[runId].planId;
  const completed = expectedCompletedEnvelope(baseline, selectedPlanId, runId);
  const expected = preservationSnapshot(completed, selectedPlanId, runId);
  assertPreservationCoverage(expected, selectedPlanId, runId, unrelated);
  return { baseline, expected, selectedPlanId };
}

function addUnrelatedRecords(state) {
  const selectedPlan = Object.values(state.upgrades.plans)[0];
  const selectedJournal = Object.values(state.upgrades.journal)[0];
  const body = structuredClone(selectedPlan);
  delete body.id;
  body.target.catalogDigest = "e".repeat(64);
  const plan = { ...body, id: digest(body) };
  const journal = structuredClone(selectedJournal);
  journal.runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  journal.planId = plan.id;
  journal.phase = "compensated";
  journal.cursor = sourceTips(journal);
  state.upgrades.plans[plan.id] = plan;
  state.upgrades.journal[journal.runId] = journal;
  state.infrastructure.generations.extra = structuredClone(
    state.infrastructure.generations.g1,
  );
  return { planId: plan.id, runId: journal.runId, generationId: "extra" };
}

function sourceTips(journal) {
  return journal.sourceRevisions.map((source) => {
    const receipt =
      source.providerId === journal.control.providerId &&
      source.revision.layer === journal.control.revision.layer
        ? journal.control.receipts.at(-1)?.revision
        : undefined;
    return { providerId: source.providerId, revision: receipt ?? source.revision };
  });
}
