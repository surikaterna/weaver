import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createHash } from "node:crypto";
import { canonicalInternalJson, internalRegistrationId } from "@weaver-conf/config-types";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createServerRest } from "../src/server-transport.ts";
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
    const control = runtime.configService.providers.find((item) => item.id === "control");
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
    const provider = runtime.configService.providers.find((item) => item.id === "platform");
    const control = runtime.configService.providers.find((item) => item.id === "control");
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

test("unrecorded schema-valid final revision blocks before activation", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal((await runtime.configService.set("platform", "svc.keep", true)).success, true);
    const data = runtime.configService.providers.find((item) => item.id === "platform");
    const control = runtime.configService.providers.find((item) => item.id === "control");
    const original = control.authority.commitLayer.bind(control.authority);
    let injected = false;
    let activations = 0;
    mock.method(control.authority, "commitLayer", async (request, handle) => {
      if (request.mutation.action === "set" && request.mutation.key === "_weaver") activations++;
      const result = await original(request, handle);
      if (!injected && request.mutation.action === "set" && request.mutation.value?.phase === "verifying") {
        injected = true;
        assert.equal((await data.write("svc", { keep: true, added: "unrecorded" })).success, true);
      }
      return result;
    });
    await assert.rejects(runtime.applyUpgrade({ version: 1, request: planRequest(runtime, fixture.request) }), { code: "REVISION_CONFLICT" });
    assert.equal(injected, true);
    assert.equal(activations, 0);
    assert.equal(runtime.state, "maintenance");
  } finally {
    mock.restoreAll();
    await runtime?.close();
    await fixture.dispose();
  }
});

test("unrecorded control self-write blocks before activation", async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials });
    assert.equal((await runtime.configService.set("platform", "svc.keep", true)).success, true);
    const control = runtime.configService.providers.find((item) => item.id === "control");
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
    await assert.rejects(runtime.applyUpgrade({ version: 1, request: planRequest(runtime, fixture.request) }), { code: "REVISION_CONFLICT" });
    assert.equal(injected, true);
    assert.equal(activations, 0);
  } finally {
    mock.restoreAll();
    await runtime?.close();
    await fixture.dispose();
  }
});

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
    const control = runtime.configService.providers.find((item) => item.id === "control");
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
    const platform = runtime.configService.providers.find((item) => item.id === "platform");
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
