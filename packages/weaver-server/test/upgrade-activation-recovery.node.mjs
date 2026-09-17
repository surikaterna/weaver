import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  canonicalInternalJson,
  internalRegistrationId,
} from "@weaver-conf/config-types";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";
import { rawRuntimeProviders } from "./upgrade-test-providers.mjs";

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

for (const boundary of [
  "before-intent",
  "after-intent",
  "after-activation",
  "after-completion",
]) {
  test(`activation recovery converges after durable ${boundary}`, async (t) => {
    const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
    let runtime;
    try {
      await initializeWeaver(
        fixture.seed,
        fixture.request,
        fixture.administrator,
        { credentials: fixture.credentials },
      );
      runtime = await open(fixture);
      assert.equal(
        (await runtime.configService.set("platform", "svc.keep", true)).success,
        true,
      );
      const counts = { activation: 0, intent: 0, completion: 0 };
      instrument(t, runtime, counts, boundary);
      await assert.rejects(
        runtime.applyUpgrade({
          version: 1,
          request: planRequest(runtime, fixture.request),
        }),
      );
      const runId = runtime.maintenanceStatus().activeRun.runId;
      await runtime.close();
      runtime = await open(fixture);
      instrument(t, runtime, counts);
      const request = {
        version: 1,
        runId,
        priorOwnerStopped: {
          observedAt: new Date().toISOString(),
          evidence: "prior durable fixture runtime was closed",
        },
      };
      const recovered = await runtime.recoverUpgrade(request);
      assert.equal(recovered.status, "completed");
      assert.equal((await runtime.recoverUpgrade(request)).status, "completed");
      assert.equal(counts.activation, 1);
      assert.equal(runtime.state, "ready");
      assert.deepEqual(await runtime.configService.get("svc"), {
        keep: true,
        added: "planned",
      });
      assert.equal(
        (await runtime.configService.set("platform", "svc.keep", false)).success,
        true,
      );
      assert.equal(counts.intent, boundary === "after-intent" ? 2 : 1);
      assert.equal(counts.completion, 1);
    } finally {
      t.mock.restoreAll();
      await runtime?.close();
      await fixture.dispose();
    }
  });
}

function instrument(t, runtime, counts, boundary) {
  const provider = rawRuntimeProviders(runtime).find(
    (candidate) => candidate.id === "control",
  );
  const commit = provider.authority.commitLayer.bind(provider.authority);
  let faulted = false;
  t.mock.method(provider.authority, "commitLayer", async (request, handle) => {
    const status = activationStatus(request);
    const kind = status;
    if (!faulted && shouldFault(boundary, request.mutation.key, kind)) {
      faulted = true;
      if (boundary === "after-completion") {
        const result = await commit(request, handle);
        count(result, request.mutation.key, kind, counts);
      }
      return { success: false, error: { code: "WRITE_ERROR", message: "fault" } };
    }
    const result = await commit(request, handle);
    count(result, request.mutation.key, kind, counts);
    return result;
  });
}

function shouldFault(boundary, key, status) {
  if (boundary === "before-intent")
    return key.startsWith("_weaver.upgrades.journal.") && status === "intent";
  if (boundary === "after-intent") return key === "_weaver" && status === "intent";
  if (boundary === "after-activation")
    return key === "_weaver" && status === "complete";
  return boundary === "after-completion" && key === "_weaver" && status === "complete";
}

function activationStatus(request) {
  const value = request.mutation.action === "set" ? request.mutation.value : undefined;
  if (!value || typeof value !== "object") return undefined;
  if (request.mutation.key.startsWith("_weaver.upgrades.journal."))
    return value.activation?.status;
  const journals = value.upgrades?.journal;
  return journals ? Object.values(journals).at(-1)?.activation?.status : undefined;
}

function count(result, key, status, counts) {
  if (!result.success) return;
  if (key.startsWith("_weaver.upgrades.journal.") && status === "intent")
    counts.intent++;
  if (key === "_weaver" && status === "intent") counts.activation++;
  if (key === "_weaver" && status === "complete") counts.completion++;
}

async function open(fixture) {
  return openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
}

function planRequest(runtime, initialization) {
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
    },
  };
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}
