import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  internalConfigurationSchema,
  internalRegistrationId,
} from "@weaver-conf/config-types";
import { hostForControl } from "../src/core/config-service-internal.ts";
import {
  observeAdmission,
  withCrashRuntime,
} from "./upgrade-recovery-matrix-fixture.mjs";
import { durableReplace } from "./upgrade-final-matrix-fixture.mjs";
import {
  assertStaleRow,
  digestValue,
  forgedId,
  replacePlan,
  selected,
  zeroDigest,
} from "./upgrade-stale-matrix-fixture.mjs";

const rows = [
  ["run/map-key identity (schema-invalid)", true, (envelope, runId) => {
    const { state, journal } = selected(envelope, runId);
    delete state.upgrades.journal[runId];
    state.upgrades.journal[randomUUID()] = journal;
  }],
  ["step id/order identity", false, (envelope, runId) => {
    selected(envelope, runId).journal.steps[0].id = forgedId();
  }],
  ["step operation identity and receipt lineage", false, (envelope, runId) => {
    const step = selected(envelope, runId).journal.steps[0];
    const operationId = randomUUID();
    step.operationId = operationId;
    step.receipt.operationId = operationId;
  }],
  ["source catalog digest", false, (envelope, runId) => {
    replacePlan(envelope, runId, (plan) => {
      plan.source.catalogDigest = zeroDigest();
    });
  }],
  ["target catalog digest", false, (envelope, runId) => {
    replacePlan(envelope, runId, (plan) => {
      plan.target.catalogDigest = zeroDigest();
    });
  }],
  ["source schema/registration authority", false, (envelope, runId) => {
    const { state } = selected(envelope, runId);
    const [oldId, source] = Object.entries(state.catalog.registrations)[0];
    const changed = structuredClone(source);
    changed.request.schema.properties.forged = { type: "string" };
    delete state.catalog.registrations[oldId];
    state.catalog.registrations[internalRegistrationId(changed)] = changed;
  }],
  ["target schema/registration authority", false, (envelope, runId) => {
    replacePlan(envelope, runId, (plan) => {
      const [oldId, target] = Object.entries(plan.target.registrations)[0];
      const changed = structuredClone(target);
      changed.request.schema.properties.forged = { type: "string" };
      delete plan.target.registrations[oldId];
      plan.target.registrations[internalRegistrationId(changed)] = changed;
      plan.target.catalogDigest = digestValue({
        registrations: plan.target.registrations,
      });
    });
  }],
  ["source data and poststate physical digest", false, (envelope, runId) => {
    replacePlan(envelope, runId, (plan, journal) => {
      plan.source.dataDigests[1].digest = zeroDigest();
      plan.finalLayers[1].sourceDigest = zeroDigest();
      journal.steps[0].postDigest = zeroDigest();
    });
  }],
  ["provider revision vectors/sourceRevisions/cursor/step receipt revisions", false,
    (envelope, runId) => {
      const epoch = randomUUID();
      const { journal } = replacePlan(envelope, runId, (plan) => {
        plan.source.providerRevisions[1].revisions[0].epoch = epoch;
        plan.steps[0].expectedRevision.epoch = epoch;
      });
      journal.sourceRevisions[1].revision.epoch = epoch;
      journal.cursor[1].revision.epoch = epoch;
      journal.steps[0].preRevision.epoch = epoch;
      journal.steps[0].receipt.previousRevision.epoch = epoch;
      journal.steps[0].receipt.revision.epoch = epoch;
    }],
  ["scope inventory revision/content/context set", false, (envelope, runId) => {
    replacePlan(envelope, runId, (plan) => {
      plan.source.inventoryRevision = "1";
      plan.contexts = [[{ scopeId: "region", value: "forged" }]];
    });
  }],
  ["infrastructure source/current/target generation", false, (envelope, runId) => {
    const { journal } = replacePlan(envelope, runId, (plan) => {
      plan.source.infrastructureGeneration = forgedId();
      plan.target.infrastructureGeneration = forgedId();
    });
    journal.infrastructureGeneration = forgedId();
  }],
  ["target provider ID", false, authorityMutation("providerId", forgedId())],
  ["target provider namespace", false, authorityMutation("namespace", "forged")],
  ["target provider store", false, authorityMutation("storeId", forgedId())],
  ["target provider environment", false, authorityMutation("environment", "forged")],
  ["target provider layer", false, authorityMutation("layer", forgedId())],
  ["final layer source/final digests", false, (envelope, runId) => {
    replacePlan(envelope, runId, (plan) => {
      plan.finalLayers[1].sourceDigest = zeroDigest();
      plan.source.dataDigests[1].digest = zeroDigest();
      plan.finalLayers[1].finalDigest = zeroDigest();
    });
  }],
];

function authorityMutation(field, value) {
  return (envelope, runId) => {
    const { journal } = replacePlan(envelope, runId, (plan) => {
      mutatePlanAuthority(plan, field, value);
    });
    mutateJournalAuthority(journal, field, value);
  };
}

function mutatePlanAuthority(plan, field, value) {
  const source = plan.source.providerRevisions[1];
  const revision = source.revisions[0];
  if (field === "providerId") source.providerId = value;
  else if (field !== "namespace") revision[field] = value;
  if (field !== "environment") plan.source.dataDigests[1][field] = value;
  plan.finalLayers[1][field] = value;
  if (field !== "environment") plan.steps[0].target[field] = value;
  if (!["providerId", "namespace"].includes(field))
    plan.steps[0].expectedRevision[field] = value;
}

function mutateJournalAuthority(journal, field, value) {
  const source = journal.sourceRevisions[1];
  const cursor = journal.cursor[1];
  const step = journal.steps[0];
  if (field === "providerId") {
    source.providerId = value;
    cursor.providerId = value;
  } else if (field !== "namespace") {
    source.revision[field] = value;
    cursor.revision[field] = value;
    step.preRevision[field] = value;
    step.receipt.previousRevision[field] = value;
    step.receipt.revision[field] = value;
  }
  if (field !== "environment") step.target[field] = value;
}

for (const [name, schemaInvalid, mutate] of rows)
  test(`stale plan: ${name}`, (t) => assertStaleRow(t, { name, schemaInvalid, mutate }));

test("schema-valid stale cache is rejected before owner adoption", async (t) => {
  const row = { name: "predata", fault: "data", initial: "applying" };
  await withCrashRuntime(t, row, async ({ fixture, runtime, request, effects, reopen }) => {
    await assert.rejects(runtime.applyUpgrade({ version: 1, request }));
    const recovered = await reopen();
    const path = fixture.seed.store.locator.filePath;
    const before = await readFile(path, "utf8");
    const host = hostForControl(recovered.configService);
    const entries = structuredClone(host.layerData.get("control"));
    const journal = Object.values(entries._weaver.upgrades.journal)[0];
    journal.steps[0].id = forgedId();
    host.layerData.set("control", entries);
    const checkpoint = effects.checkpoint();
    await assert.rejects(recovered.recoverUpgrade({
      version: 1,
      runId: journal.runId,
      priorOwnerStopped: {
        observedAt: new Date().toISOString(),
        evidence: "prior FS runtime closed",
      },
    }), { code: "VALIDATION_ERROR" });
    assert.deepEqual(effects.records(checkpoint), []);
    assert.equal(await readFile(path, "utf8"), before);
  });
});

for (const row of [
  { name: "prepared", fault: "applying", initial: "prepared" },
  { name: "applying-pending", fault: "intent", initial: "applying" },
  { name: "applying-intent", fault: "data", initial: "applying" },
])
  test(`${row.name} recovery rejects stale current authority before writes`, async (t) => {
    await withCrashRuntime(t, row, async ({ fixture, runtime, request, effects, reopen }) => {
    await assert.rejects(runtime.applyUpgrade({ version: 1, request }));
    const runId = runtime.maintenanceStatus().activeRun.runId;
    const platformPath = join(fixture.directory, "platform", "entries.json");
    const controlPath = fixture.seed.store.locator.filePath;
    let expected;
    let recovered = await reopen(async () => {
      const envelope = JSON.parse(await readFile(platformPath, "utf8"));
      envelope.entries.svc.keep = false;
      await durableReplace(platformPath, envelope);
      expected = await rawFiles(controlPath, platformPath);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const checkpoint = effects.checkpoint();
      await assert.rejects(recovered.recoverUpgrade(recoveryRequest(runId)), {
        code: "REVISION_CONFLICT",
      });
      assert.deepEqual(effects.records(checkpoint), []);
      assert.deepEqual(await rawFiles(controlPath, platformPath), expected);
      if (attempt === 0) recovered = await reopen();
    }
    });
  });

const postOpenControlRows = [
  {
    name: "prepared raw journal owner",
    fault: "applying",
    mutate(envelope, runId) {
      selected(envelope, runId).journal.owner = randomUUID();
    },
  },
  {
    name: "applying-pending raw journal receipt lineage",
    fault: "intent",
    mutate(envelope, runId) {
      const receipts = selected(envelope, runId).journal.control.receipts;
      receipts[receipts.length - 1].mutationDigest = zeroDigest();
    },
  },
  {
    name: "applying-intent raw selected plan",
    fault: "data",
    mutate(envelope, runId) {
      replacePlan(envelope, runId, (plan) => {
        plan.source.catalogDigest = zeroDigest();
      });
    },
  },
];

for (const row of postOpenControlRows)
  test(`${row.name} divergence is rejected after runtime open`, async (t) => {
    await withCrashRuntime(t, row, async ({ fixture, runtime, request, effects, reopen }) => {
      await assert.rejects(runtime.applyUpgrade({ version: 1, request }));
      const runId = runtime.maintenanceStatus().activeRun.runId;
      const controlPath = fixture.seed.store.locator.filePath;
      const platformPath = join(fixture.directory, "platform", "entries.json");
      let recovered = await reopen();
      const envelope = JSON.parse(await readFile(controlPath, "utf8"));
      row.mutate(envelope, runId);
      internalConfigurationSchema.parse(envelope.entries._weaver);
      await durableReplace(controlPath, envelope);
      const corrupted = await rawFiles(controlPath, platformPath);
      const checkpoint = effects.checkpoint();
      const failures = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const admission = observeAdmission(t, recovered);
        try {
          await recovered.recoverUpgrade(recoveryRequest(runId));
          assert.fail("divergent raw recovery unexpectedly succeeded");
        } catch (error) {
          failures.push({ code: error.code, message: error.message });
        }
        assert.deepEqual(effects.records(checkpoint), []);
        assert.deepEqual(admission.snapshot(),
          { installs: 0, opens: 0, resumes: 0, publications: 0 });
        admission.close();
        assert.deepEqual(await rawFiles(controlPath, platformPath), corrupted);
        if (attempt === 0) recovered = await reopen();
      }
      assert.deepEqual(failures[1], failures[0]);
      assert.equal(failures[0].code, "VALIDATION_ERROR");
      assert.equal(recovered.maintenanceStatus().ready, false);
      assert.notEqual(recovered.state, "ready");
    });
  });

function recoveryRequest(runId) {
  return {
    version: 1,
    runId,
    priorOwnerStopped: {
      observedAt: new Date().toISOString(),
      evidence: "prior filesystem runtime closed",
    },
  };
}

async function rawFiles(...paths) {
  return Promise.all(paths.map((path) => readFile(path, "utf8")));
}
