import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  internalUpgradeLayerDigest,
  layerCommitRequestSchema,
} from "@weaver-conf/config-types";
import { computeProviderMutationDigest } from "@weaver-conf/storage-providers";
import { MongoClient } from "mongodb";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { seedProviderDefinition } from "../src/bootstrap/compile-layout.ts";
import { authenticateBootstrapAdministrator } from "../src/bootstrap/seed-trust.ts";
import { hostForControl } from "../src/core/config-service-internal.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { startWeaverServer } from "../src/server.ts";
import {
  createStandaloneFixture,
  testAdmin,
  testJwt,
} from "./standalone-fixture.ts";
import {
  assertPublicSecretSafe,
  createMongoUpgradeFixture,
  journal,
  observeMongoDataWrites,
  publicRejection,
  requireLiveUris,
  revision,
  withoutId,
} from "./upgrade-mongo-fixture.mjs";
import {
  planRequest,
  sourceSchema,
  targetSchema,
} from "./upgrade-planner-fixture.mjs";

const bootstrapSchema = { type: "object", default: {}, additionalProperties: false, properties: { value: { type: "integer", default: 1 } } };
const { primaryUri } = requireLiveUris();

test("qkmd real Mongo seed initialize/start/read/close/restart and failed reload is nonready", { timeout: 60_000 }, async () => {
  const uri = primaryUri;
  const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 }).connect();
  const database = `weaver_bootstrap_test_${randomUUID().replaceAll("-", "")}`;
  const fixture = await createStandaloneFixture({ schemas: { svc: bootstrapSchema } });
  let server;
  try {
    const storeId = `mongo:${client.options.hosts.map((host) => host.toString()).sort().join(",")}/${database}.control`;
    const seed = { ...fixture.seed, store: { factory: "mongodb", locator: { connectionRef: "database", database, collection: "control", storeId } } };
    const credentials = { resolveCredential: (ref) => ref === "database" ? uri : ref === "administrator" ? testAdmin : ref === "jwt" ? testJwt : undefined };
    const input = structuredClone(fixture.request);
    input.generation.providers = [seedProviderDefinition(seed), { id: "platform", factory: "mongodb", options: { database, collection: "platform" }, credentials: { connection: "database" } }];
    const administrator = await authenticateBootstrapAdministrator(seed, testAdmin, credentials);
    await initializeWeaver(seed, input, administrator, { credentials });
    server = await startWeaverServer({ seed, credentials });
    assert.equal((await server.runtime.configService.set("platform", "svc.value", 9)).success, true);
    const revision = server.runtime.configService.revision;
    await server.close();
    server = await startWeaverServer({ seed, credentials });
    assert.equal(server.runtime.configService.revision, revision);
    assert.equal(await server.runtime.configService.get("svc.value"), 9);
    const collection = client.db(database).collection("platform");
    const original = await collection.findOne({ layer: "platform" });
    await collection.updateOne({ layer: "platform" }, { $set: { sequence: "corrupt" } });
    await assert.rejects(server.runtime.configService.reloadProvider("platform"));
    assert.equal(server.isReady, false);
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/readyz`, { signal: AbortSignal.timeout(30_000) })).status, 503);
    await collection.updateOne({ layer: "platform" }, { $set: { sequence: original.sequence } });
    await server.runtime.configService.reloadProvider("platform");
    assert.equal(await server.runtime.configService.get("svc.value"), 9);
  } finally { await server?.close(); await client.db(database).dropDatabase(); await client.close(); await fixture.dispose(); }
});

test("runtime planner reads real Mongo authority without mutation", { timeout: 30_000 }, async () => {
  const uri = primaryUri;
  const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 }).connect();
  const database = `weaver_planner_${randomUUID().replaceAll("-", "")}`;
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    const storeId = `mongo:${client.options.hosts.map((host) => host.toString()).sort().join(",")}/${database}.control`;
    const seed = { ...fixture.seed, store: { factory: "mongodb", locator: { connectionRef: "database", database, collection: "control", storeId } } };
    const credentials = { resolveCredential: (ref) => ref === "database" ? uri : ref === "administrator" ? testAdmin : ref === "jwt" ? testJwt : undefined };
    const request = structuredClone(fixture.request);
    request.generation.providers = [seedProviderDefinition(seed), { id: "platform", factory: "mongodb", options: { database, collection: "platform" }, credentials: { connection: "database" } }];
    const administrator = await authenticateBootstrapAdministrator(seed, testAdmin, credentials);
    await initializeWeaver(seed, request, administrator, { credentials });
    runtime = await openWeaverRuntime(seed, { credentials });
    assert.equal((await runtime.configService.set("platform", "svc.keep", false)).success, true);
    const before = await client.db(database).collection("platform").findOne({ layer: "platform" });
    const result = await runtime.planUpgrade(planRequest(runtime, request, targetSchema));
    const after = await client.db(database).collection("platform").findOne({ layer: "platform" });
    assert.equal(result.result.status, "ready");
    assert.deepEqual(after, before);
  } finally {
    await runtime?.close();
    await client.db(database).dropDatabase();
    await client.close();
    await fixture.dispose();
  }
});

test("U9.3 normal public apply publishes each FS and Mongo effect exactly once", async () => {
  const fixture = await createMongoUpgradeFixture();
  let runtime = await fixture.open();
  let observer;
  try {
    const installed = await fixture.prepare(runtime);
    const runId = randomUUID();
    const before = await fixture.snapshot();
    const publications = [];
    const unsubscribe = runtime.configService.onDelta((event) => publications.push(event));
    observer = observeMongoDataWrites(fixture, runId);
    const result = await runtime.applyUpgrade({
      version: 1,
      runId,
      request: installed.request,
    });
    assert.equal(observer.operationIds.length, 1);
    observer.restore();
    observer = undefined;
    unsubscribe();
    assert.equal(result.status, "completed");
    assert.equal(runtime.state, "ready");
    const after = await fixture.snapshot();
    assertCompleted(before, after, installed.plan, runId);
    assert.deepEqual(publications, []);
    assert.equal(observer, undefined);
    await runtime.close();
    runtime = await fixture.open();
    const terminalBefore = await fixture.snapshot();
    const terminalObserver = observeMongoDataWrites(fixture, runId);
    try {
      assert.equal(
        (await runtime.recoverUpgrade({ version: 1, runId })).status,
        "completed",
      );
      assert.equal(
        (await runtime.recoverUpgrade({ version: 1, runId })).status,
        "completed",
      );
      assert.deepEqual(terminalObserver.operationIds, []);
      assertRawEqual(await fixture.snapshot(), terminalBefore);
    } finally {
      terminalObserver.restore();
    }
  } finally {
    observer?.restore();
    await runtime.close();
    await fixture.dispose();
  }
});

test("U9.3 recovery recognizes Mongo receipt after control completion fails", async (t) => {
  await runReceiptIncomplete(t);
});

async function runReceiptIncomplete(t) {
  const fixture = await createMongoUpgradeFixture();
  let runtime = await fixture.open();
  try {
    const installed = await fixture.prepare(runtime);
    const runId = randomUUID();
    const before = await fixture.snapshot();
    const partial = await faultReceiptPersistence(
      t, fixture, runtime, installed.request, runId, before,
    );
    await runtime.close();
    runtime = await fixture.open();
    await recoverReceipt(fixture, runtime, runId, partial);
  } finally {
    await runtime.close();
    await fixture.dispose();
  }
}

async function faultReceiptPersistence(t, fixture, runtime, request, runId, before) {
  const observer = observeMongoDataWrites(fixture, runId);
  const control = provider(runtime, "control");
  const commit = control.authority.commitLayer.bind(control.authority);
  let faulted = false;
  const fault = t.mock.method(control.authority, "commitLayer", async (input, handle) => {
    if (!faulted && completedSecondary(input, runId)) {
      faulted = true;
      return failedControlWrite();
    }
    return commit(input, handle);
  });
  try {
    const error = await publicRejection(
      runtime.applyUpgrade({ version: 1, runId, request }),
    );
    assert.equal(observer.operationIds.length, 1);
    assert.equal(faulted, true);
    assert.equal(error.code, "INTERNAL_ERROR");
    assert.equal(error.details.maintenanceCode, "storage");
    assertPublicSecretSafe(error, fixture, ["injected-control-secret-after-mongo"]);
    const partial = await fixture.snapshot();
    await assertReceiptIncomplete(runtime, partial, before, runId);
    return partial;
  } finally {
    fault.mock.restore();
    observer.restore();
  }
}

async function recoverReceipt(fixture, runtime, runId, partial) {
  const observer = observeMongoDataWrites(fixture, runId);
  try {
    const recovered = await runtime.recoverUpgrade({
      version: 1,
      runId,
      priorOwnerStopped: stoppedEvidence(),
    });
    assert.equal(recovered.status, "completed");
    assert.equal(runtime.state, "ready");
    assert.deepEqual(observer.operationIds, []);
    const final = await fixture.snapshot();
    assert.equal(journal(final, runId).activation.status, "complete");
    assert.deepEqual(authorityEnvelope(final.mongo), authorityEnvelope(partial.mongo));
  } finally {
    observer.restore();
  }
}

async function assertReceiptIncomplete(runtime, partial, before, runId) {
  const recorded = journal(partial, runId);
  assert.equal(recorded.phase, "applying");
  assert.equal(recorded.steps.at(-1).status, "intent");
  assert.equal(recorded.activation.status, "pending");
  assert.equal(runtime.state, "maintenance");
  await assert.rejects(runtime.configService.get("alpha"), {
    code: "MAINTENANCE",
  });
  assert.equal(
    withoutId(partial.mongo).lastCommit.operationId,
    recorded.steps.at(-1).operationId,
  );
  assert.equal(BigInt(partial.mongo.sequence) - BigInt(before.mongo.sequence), 1n);
}

function failedControlWrite() {
  return {
    success: false,
    error: {
      code: "CONTROL_PROVIDER_FAILURE",
      message: "injected-control-secret-after-mongo",
    },
  };
}

function assertCompleted(before, after, plan, runId) {
  const completed = journal(after, runId);
  assert.equal(completed.phase, "completed");
  assert.equal(completed.activation.status, "complete");
  for (const step of completed.steps) {
    assert.equal(step.status, "complete");
    assert.equal(step.receipt.operationId, step.operationId);
    assert.equal(step.receipt.mutationDigest, mutationDigest(step));
    const previous = step.target.providerId === "platform"
      ? before.platform
      : before.mongo;
    const current = step.target.providerId === "platform"
      ? after.platform
      : after.mongo;
    assert.deepEqual(step.receipt.previousRevision, revision(previous));
    assert.deepEqual(step.receipt.revision, revision(current));
    assert.deepEqual(step.receipt, withoutId(current).lastCommit);
    assert.equal(BigInt(current.sequence) - BigInt(previous.sequence), 1n);
  }
  for (const binding of plan.finalLayers) {
    const current = binding.providerId === "control"
      ? after.control
      : binding.providerId === "platform"
        ? after.platform
        : after.mongo;
    assert.equal(
      internalUpgradeLayerDigest(current.entries, binding.contentDomain),
      binding.finalDigest,
    );
  }
  assertFinalContexts(completed, plan);
}

function assertFinalContexts(completed, plan) {
  const contexts = completed.activation.finalContexts;
  assert.equal(contexts.runId, completed.runId);
  assert.equal(contexts.planId, plan.id);
  assert.equal(contexts.targetCatalogDigest, plan.target.catalogDigest);
  assert.deepEqual(
    contexts.contexts.map((item) => item.scopePath),
    plan.contexts,
  );
  assert.deepEqual(
    contexts.layers.map((item) => ({
      providerId: item.providerId,
      namespace: item.namespace,
      contentDigest: item.contentDigest,
    })),
    plan.finalLayers.map((item) => ({
      providerId: item.providerId,
      namespace: item.namespace,
      contentDigest: item.finalDigest,
    })),
  );
}

function mutationDigest(step) {
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

function completedSecondary(request, runId) {
  const value = request.mutation?.value;
  return request.mutation?.action === "set" &&
    value?.runId === runId &&
    value.steps?.at(-1)?.status === "complete" &&
    value.activation?.status === "pending";
}

function assertRawEqual(left, right) {
  assert.deepEqual(left.controlBytes, right.controlBytes);
  assert.deepEqual(left.platformBytes, right.platformBytes);
  assert.deepEqual(left.mongoBytes, right.mongoBytes);
  assert.deepEqual(left.mongoCanonical, right.mongoCanonical);
}

function authorityEnvelope(document) {
  const { owner: _owner, fence: _fence, ...envelope } = withoutId(document);
  return envelope;
}

function provider(runtime, id) {
  const value = hostForControl(runtime.configService).providers.find(
    (item) => item.id === id,
  );
  assert.ok(value?.authority);
  return value;
}

function stoppedEvidence() {
  return {
    observedAt: new Date().toISOString(),
    evidence: "prior runtime closed before exact receipt recovery",
  };
}
