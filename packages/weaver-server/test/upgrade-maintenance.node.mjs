import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalInternalJson, internalRegistrationId } from "@weaver-conf/config-types";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { startWeaverServer } from "../src/server.ts";
import { createServerRest } from "../src/server-transport.ts";
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
    port: { type: "integer", default: 41 },
  },
  additionalProperties: false,
};

test("maintenance apply persists intents, data receipts, activation and reopens application", { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal((await runtime.configService.set("platform", "svc.keep", true)).success, true);
    const request = planRequest(runtime, fixture.request);
    const outcome = await runtime.applyUpgrade({ version: 1, request });
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.effects.completedSteps, 1);
    assert.equal("journal" in outcome, false);
    assert.equal(JSON.stringify(outcome).includes("finalContexts"), false);
    assert.equal(runtime.state, "ready");
    assert.deepEqual(await runtime.configService.get("svc"), { keep: true, added: "planned", port: 41 });
    const control = rawRuntimeProviders(runtime).find((item) => item.id === "control");
    const envelope = await control.authority.readLayer(control.layer);
    const journal = Object.values(envelope.entries._weaver.upgrades.journal)[0];
    assert.equal(journal.activation.finalContexts.contexts.length, 1);
    const serialized = JSON.stringify(journal.activation.finalContexts);
    assert.equal(serialized.includes('"keep":true'), false);
    assert.equal(serialized.includes('"added":"planned"'), false);
  } finally {
    await runtime?.close();
    await fixture.dispose();
  }
});

test("successful terminal admission reopens the existing server SSE adapter", { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let server;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    server = await startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials });
    assert.equal((await server.runtime.configService.set("platform", "svc.keep", true)).success, true);
    const endpoint = `http://127.0.0.1:${server.port}/v1/events`;
    const original = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
    assert.equal(original.status, 200);
    const originalReader = original.body.getReader();
    assert.equal((await originalReader.read()).done, false);
    const request = planRequest(server.runtime, fixture.request);
    const outcome = await server.runtime.applyUpgrade({ version: 1, request });
    assert.equal(outcome.status, "completed");
    assert.equal(server.runtime.state, "ready");
    assert.equal((await originalReader.read()).done, true);
    const resumed = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
    assert.equal(resumed.status, 200);
    const resumedReader = resumed.body.getReader();
    assert.equal((await resumedReader.read()).done, false);
    await resumedReader.cancel();
  } finally {
    await server?.close();
    await fixture.dispose();
  }
});

test("stale apply enters maintenance but performs zero persisted upgrade writes", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    const request = planRequest(runtime, fixture.request);
    request.expectedAuthorityRevision = "authority-v1.stale";
    await assert.rejects(runtime.applyUpgrade({ version: 1, request }), { code: "REVISION_CONFLICT" });
    assert.equal(runtime.state, "ready");
    const state = runtime.maintenanceStatus();
    assert.equal(state.ready, true);
    assert.equal(state.activeRun, undefined);
    assert.equal(await runtime.configService.get("svc"), undefined);
  } finally {
    await runtime?.close();
    await fixture.dispose();
  }
});

test("maintenance closes an active SCOMP subscription and rejects new application calls", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    const peer = { identity: { userId: "operator", roles: ["admin"] }, isAdmin: true, isUser: true, isService: false };
    const scomp = runtime.createScompService(() => peer);
    const subscription = scomp.router["weaver-config-v1.subscribe"].handler({})[Symbol.asyncIterator]();
    const waiting = subscription.next();
    await runtime.enterMaintenance();
    assert.equal((await waiting).done, true);
    await assert.rejects(scomp.router["weaver-config-v1.get"].handler({ key: "svc" }), { code: "MAINTENANCE" });
  } finally {
    await runtime?.close();
    await fixture.dispose();
  }
});

test("data-committed recovery remains closed without ephemeral final context evidence", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal((await runtime.configService.set("platform", "svc.keep", true)).success, true);
    const provider = rawRuntimeProviders(runtime).find((item) => item.id === "platform");
    const control = rawRuntimeProviders(runtime).find((item) => item.id === "control");
    const original = control.authority.commitLayer.bind(control.authority);
    let completions = 0;
    mock.method(control.authority, "commitLayer", async (request, handle) => {
      if (request.mutation.action === "set" && request.mutation.key.includes("upgrades.journal") && request.mutation.value?.steps?.[0]?.status === "complete") {
        completions++;
        if (completions === 1) return { success: false, error: { code: "WRITE_ERROR", message: "injected completion failure" } };
      }
      return original(request, handle);
    });
    await assert.rejects(runtime.applyUpgrade({ version: 1, request: planRequest(runtime, fixture.request) }));
    const status = runtime.maintenanceStatus();
    assert.equal(status.activeRun.phase, "applying");
    const before = await provider.authority.readLayer("platform");
    const commit = mock.method(provider.authority, "commitLayer");
    const recovered = await runtime.recoverUpgrade({ version: 1, runId: status.activeRun.runId, priorOwnerStopped: { observedAt: new Date().toISOString(), evidence: "same process completion retry" } });
    assert.equal(recovered.status, "blocked");
    assert.equal(runtime.state, "maintenance");
    assert.equal(commit.mock.callCount(), 0);
    assert.deepEqual(await provider.authority.readLayer("platform"), before);
  } finally {
    mock.restoreAll();
    await runtime?.close();
    await fixture.dispose();
  }
});

test("post-control-write data conflict reports uncertainty before activation", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal((await runtime.configService.set("platform", "svc.keep", true)).success, true);
    const data = rawRuntimeProviders(runtime).find((item) => item.id === "platform");
    const control = rawRuntimeProviders(runtime).find((item) => item.id === "control");
    const original = control.authority.commitLayer.bind(control.authority);
    let platformBefore;
    let injected = false;
    let activations = 0;
    mock.method(control.authority, "commitLayer", async (request, handle) => {
      if (request.mutation.action === "set" && request.mutation.key === "_weaver") activations++;
      const result = await original(request, handle);
      if (!injected && request.mutation.action === "set" && request.mutation.value?.phase === "verifying") {
        injected = true;
        platformBefore = structuredClone(await readFixtureEnvelope(fixture, "platform"));
        const nested = await data.write("svc", { keep: true, added: "unrecorded" });
        assert.equal(nested.success, false);
        assert.equal(nested.error.code, "WRITER_CONFLICT");
        throw new Error("synthetic known post-control-write failure");
      }
      return result;
    });
    const error = await publicRejection(
      runtime.applyUpgrade({ version: 1, request: planRequest(runtime, fixture.request) }),
    );
    assertUncertainPublicError(error);
    assert.equal(injected, true);
    assert.ok(platformBefore);
    assert.equal(activations, 0);
    const platformAfter = await readFixtureEnvelope(fixture, "platform");
    assert.deepEqual(platformAfter, platformBefore);
    assert.equal(canonicalInternalJson(platformAfter), canonicalInternalJson(platformBefore));
    await assertVerifyingState(runtime, fixture);
  } finally {
    mock.restoreAll();
    await runtime?.close();
    await fixture.dispose();
  }
});

test("post-control-write control authority divergence reports uncertainty", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal((await runtime.configService.set("platform", "svc.keep", true)).success, true);
    const control = rawRuntimeProviders(runtime).find((item) => item.id === "control");
    const original = control.authority.commitLayer.bind(control.authority);
    const originalInventory = control.authority.inventory.bind(control.authority);
    const originalRead = control.authority.readLayer.bind(control.authority);
    let injected = false;
    let activations = 0;
    mock.method(control.authority, "commitLayer", async (request, handle) => {
      if (request.mutation.action === "set" && request.mutation.key === "_weaver") activations++;
      const result = await original(request, handle);
      if (!injected && request.mutation.action === "set" && request.mutation.value?.phase === "verifying") {
        injected = true;
      }
      return result;
    });
    mock.method(control.authority, "inventory", async () => {
      const inventory = await originalInventory();
      return injected ? { ...inventory, revisions: inventory.revisions.map((revision) => ({ ...revision, sequence: String(BigInt(revision.sequence) + 8n) })) } : inventory;
    });
    mock.method(control.authority, "readLayer", async (layer) => {
      const envelope = await originalRead(layer);
      return injected ? { ...envelope, sequence: String(BigInt(envelope.sequence) + 8n), entries: { ...envelope.entries, tampered: true } } : envelope;
    });
    const error = await publicRejection(
      runtime.applyUpgrade({ version: 1, request: planRequest(runtime, fixture.request) }),
    );
    assertUncertainPublicError(error);
    assert.equal(injected, true);
    assert.equal(activations, 0);
    await assertVerifyingState(runtime, fixture);
  } finally {
    mock.restoreAll();
    await runtime?.close();
    await fixture.dispose();
  }
});

async function publicRejection(promise) {
  return promise.then(
    () => assert.fail("expected public upgrade rejection"),
    (error) => error,
  );
}

function assertUncertainPublicError(error) {
  assert.equal(error.code, "COMMIT_OUTCOME_UNKNOWN");
  assert.equal(error.message, "Upgrade outcome is uncertain; operator action is required");
  assert.equal(error.details.maintenanceCode, "unknown-commit");
  assert.equal(error.details.category, "uncertainty");
  assert.equal(error.message.includes("synthetic known post-control-write failure"), false);
}

async function assertVerifyingState(runtime, fixture) {
  assert.equal(runtime.state, "maintenance");
  assertUncertainPublicError(captureSyncError(() => runtime.maintenanceStatus()));
  const envelope = await readFixtureEnvelope(fixture, "control");
  const journals = Object.values(envelope.entries._weaver.upgrades.journal);
  assert.equal(journals.length, 1);
  assert.equal(journals[0].phase, "verifying");
}

function captureSyncError(operation) {
  let caught;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  return caught;
}

async function readFixtureEnvelope(fixture, providerId) {
  assert.ok(providerId === "control" || providerId === "platform");
  const filePath = providerId === "control"
    ? fixture.seed.store.locator.filePath
    : fixture.request.generation.providers.find((item) => item.id === providerId)?.options.filePath;
  assert.equal(typeof filePath, "string");
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("upgrade REST routes require admin and remain callable during maintenance", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    const transport = await createServerRest({ jwtSecret: runtime.authenticationKey, adminRoles: ["admin"], environment: "dev", corsOrigins: ["https://admin.example"] }, runtime.configService, runtime.schemaRegistry, runtime.scopeManager, runtime);
    const denied = await transport.restAdapter.handleRequest("GET", "/v1/admin/upgrades/status", { params: {}, query: {}, headers: { origin: "https://admin.example" } });
    assert.equal(denied.status, 403);
    await runtime.enterMaintenance();
    const response = await transport.restAdapter.handleRequest("GET", "/v1/admin/upgrades/status", { params: {}, query: {}, headers: { origin: "https://admin.example" }, authContext: { identity: { userId: "operator", roles: ["admin"] }, isAdmin: true, isService: false, isUser: true } });
    assert.equal(response.status, 200);
    assert.equal(response.headers["Access-Control-Allow-Origin"], "https://admin.example");
    assert.equal(response.body.data.state, "maintenance");
  } finally {
    await runtime?.close();
    await fixture.dispose();
  }
});

test("explicit compensation restores a completed reversible step", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal((await runtime.configService.set("platform", "svc.keep", true)).success, true);
    const control = rawRuntimeProviders(runtime).find((item) => item.id === "control");
    const original = control.authority.commitLayer.bind(control.authority);
    mock.method(control.authority, "commitLayer", async (request, handle) => {
      if (request.mutation.action === "set" && request.mutation.key === "_weaver" && request.mutation.value?.catalog?.registrations) {
        return { success: false, error: { code: "WRITE_ERROR", message: "injected activation failure" } };
      }
      return original(request, handle);
    });
    await assert.rejects(runtime.applyUpgrade({ version: 1, request: planRequest(runtime, fixture.request) }));
    const runId = runtime.maintenanceStatus().activeRun.runId;
    const outcome = await runtime.recoverUpgrade({ version: 1, runId, action: "compensate", priorOwnerStopped: { observedAt: new Date().toISOString(), evidence: "same process operator action" } });
    assert.equal(outcome.status, "compensated");
    const platform = rawRuntimeProviders(runtime).find((item) => item.id === "platform");
    assert.deepEqual((await platform.authority.readLayer("platform")).entries.svc, { keep: true });
  } finally {
    mock.restoreAll();
    await runtime?.close();
    await fixture.dispose();
  }
});

function planRequest(runtime, initialization) {
  const sourceCatalog = {
    registrations: Object.fromEntries(initialization.registrations.map((request) => {
      const record = initialRegistrationRecord(request);
      return [internalRegistrationId(record), record];
    })),
  };
  const record = { version: 1, kind: "service", request: { ...initialization.registrations[0], schema: targetSchema }, audit: { actor: "planner" } };
  const targetCatalog = { registrations: { [internalRegistrationId(record)]: record } };
  return {
    version: 1,
    expectedAuthorityRevision: runtime.configService.revision,
    sourceCatalogDigest: digest(sourceCatalog),
    inventoryRevision: "0",
    infrastructureGeneration: "g1",
    target: { catalogDigest: digest(targetCatalog), registrations: targetCatalog.registrations },
  };
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}
