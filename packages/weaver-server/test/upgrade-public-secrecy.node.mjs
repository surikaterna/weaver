import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createHash } from "node:crypto";
import {
  canonicalInternalJson,
  createWeaverError,
  internalRegistrationId,
  upgradeExecutionResultSchema,
} from "@weaver-conf/config-types";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import { controlProjection } from "../src/core/config-service-internal.ts";
import { hostForControl } from "../src/core/config-service-internal.ts";
import { internalUpgradeResult, publicUpgradeResult } from "../src/core/public-upgrade-status.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createServerRest } from "../src/server-transport.ts";
import { publicUpgradeCliError, publicUpgradeOutput } from "../src/cli-upgrade.ts";
import { buildUpgradeRoutes } from "../src/transport/rest-upgrade-routes.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";

const raw = [
  "/home/user/secret",
  "mongodb://user:pass@host/database",
  "token=operator-token",
  'SecretReference({"ref":"credential"})',
  "\u001b[31mstack\nline",
  "x".repeat(10_000),
].join(" | ");
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

test("maintenance status and REST never serialize protected journal diagnostics", { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  const logged = [];
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, {
      credentials: fixture.credentials,
      logger: {
        debug() {}, info() {}, warn() {},
        error(...items) {
          logged.push(items);
          throw new Error(raw);
        },
      },
    });
    const { outcome, blocked } = await blockedRecovery(runtime, fixture, raw);
    assertPublic(outcome);
    const status = runtime.maintenanceStatus();
    assertPublic(status);
    assert.equal(status.activeRun.failure.code, "storage");
    const persisted = projectedJournal(runtime, blocked.runId);
    assert.equal(persisted.failure.message, raw.slice(0, 2048));

    const transport = await createServerRest({ jwtSecret: runtime.authenticationKey, adminRoles: ["admin"], environment: "dev", corsOrigins: ["https://admin.example"] }, runtime.configService, runtime.schemaRegistry, runtime.scopeManager, runtime);
    const denied = await request(transport, false);
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, {
      data: null,
      error: { code: "FORBIDDEN", message: "Upgrade ownership could not be established" },
    });
    assertUpgradeHeaders(denied.headers, true);
    const response = await request(transport, true);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { data: status });
    assertUpgradeHeaders(response.headers, true);

    const hostile = await transport.restAdapter.handleRequest("POST", "/v1/admin/upgrades/recover", {
      params: {}, query: {}, headers: { origin: "https://admin.example" },
      body: { version: 1, runId: crypto.randomUUID() },
      authContext: adminContext(),
    });
    assert.equal(hostile.status, 400);
    assert.deepEqual(hostile.body, {
      data: null,
      error: { code: "VALIDATION_ERROR", message: "Upgrade validation failed" },
    });
    assertUpgradeHeaders(hostile.headers, true);
    assert.ok(logged.length >= 1);
    assertPublic(publicUpgradeCliError());
    assert.equal(projectedJournal(runtime, blocked.runId).failure.message, raw.slice(0, 2048));
  } finally {
    mock.restoreAll();
    await runtime?.close();
    await fixture.dispose();
  }
});

test("blocked apply and unknown recovery failures are stable and non-reflecting", { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: sourceSchema } });
  const logged = [];
  let runtime;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    runtime = await openWeaverRuntime(fixture.seed, { credentials: fixture.credentials, logger: { debug() {}, info() {}, warn() {}, error(...items) { logged.push(items); } } });
    const stale = planRequest(runtime, fixture.request);
    stale.expectedAuthorityRevision = raw;
    await assert.rejects(runtime.applyUpgrade({ version: 1, request: stale }), (error) => {
      assert.equal(error.code, "REVISION_CONFLICT");
      assertPublic(error);
      return true;
    });
    await assert.rejects(runtime.recoverUpgrade({ version: 1, runId: crypto.randomUUID() }), (error) => {
      assert.equal(error.code, "VALIDATION_ERROR");
      assertPublic(error);
      return true;
    });
    assert.ok(logged.length >= 2);
  } finally {
    await runtime?.close();
    await fixture.dispose();
  }
});

test("upgrade CLI status, apply, recover and stderr surfaces serialize only public contracts", async () => {
  const blocked = upgradeExecutionResultSchema.parse({
    version: 1,
    status: "blocked",
    effects: { partialEffects: false, completedSteps: 0, pendingSteps: 0, quarantinedProviders: [] },
    failure: { code: "internal", category: "internal", message: "Upgrade could not be completed" },
  });
  const status = { version: 1, state: "failed", ready: false, failure: blocked.failure };
  for (const value of [status, blocked, blocked]) assertPublic(publicUpgradeOutput(value));
  assertPublic(publicUpgradeCliError());
});

test("REST upgrade envelopes preserve statuses without revision or cache authority", async () => {
  const blocked = upgradeExecutionResultSchema.parse({
    version: 1,
    status: "blocked",
    effects: { partialEffects: true, completedSteps: 1, pendingSteps: 0, quarantinedProviders: [] },
    failure: { code: "storage", category: "storage", message: "Upgrade storage operation failed" },
  });
  const runtime = {
    configService: { revision: "safe-revision" },
    applyUpgrade: async () => blocked,
    recoverUpgrade: async () => blocked,
    maintenanceStatus: () => ({ version: 1, state: "maintenance", ready: false }),
  };
  const routes = buildUpgradeRoutes(runtime);
  for (const path of [
    "/v1/admin/upgrades/apply",
    "/v1/admin/upgrades/recover",
    "/v1/admin/upgrades/status",
  ]) {
    const route = routes.find((candidate) => candidate.path === path);
    assert.ok(route);
    const response = await route.handler({
      authContext: { isAdmin: true },
      body: validRouteBody(path),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      data: path.endsWith("status") ? runtime.maintenanceStatus() : blocked,
    });
    assertUpgradeHeaders(response.headers, false);
  }

  const reflected = buildUpgradeRoutes({
    configService: { revision: raw },
    applyUpgrade: async () => { throw createWeaverError("REVISION_CONFLICT", raw); },
    recoverUpgrade: async () => { throw { raw, stack: raw, token: raw }; },
    maintenanceStatus: () => { throw { raw, stack: raw, token: raw }; },
  });
  const cases = [
    ["/v1/admin/upgrades/apply", 409, "REVISION_CONFLICT", "Upgrade plan is no longer current"],
    ["/v1/admin/upgrades/recover", 500, "INTERNAL_ERROR", "Upgrade could not be completed"],
    ["/v1/admin/upgrades/status", 500, "INTERNAL_ERROR", "Upgrade could not be completed"],
  ];
  for (const [path, status, code, message] of cases) {
    const route = reflected.find((candidate) => candidate.path === path);
    assert.ok(route);
    const response = await route.handler({
      authContext: { isAdmin: true },
      body: validRouteBody(path),
    });
    assert.equal(response.status, status);
    assert.deepEqual(response.body, { data: null, error: { code, message } });
    assertUpgradeHeaders(response.headers, false);
    assertPublic(response);
  }
});

async function blockedRecovery(runtime, fixture, message) {
  await runtime.configService.set("platform", "svc.keep", true);
  const control = hostForControl(runtime.configService).providers.find(
    (item) => item.id === "control",
  );
  const original = control.authority.commitLayer.bind(control.authority);
  mock.method(control.authority, "commitLayer", async (request, handle) => {
    if (request.mutation.action === "set" && request.mutation.value?.activation?.status === "complete")
      return { success: false, error: { code: "WRITE_ERROR", message } };
    return original(request, handle);
  });
  const failed = await runtime.applyUpgrade({ version: 1, request: planRequest(runtime, fixture.request) });
  assertPublic(failed);
  const runId = failed.runId;
  assert.ok(runId);
  const journal = projectedJournal(runtime, runId);
  const blocked = { ...journal, phase: "blocked", failure: { code: "storage", message: message.slice(0, 2048) } };
  exposeJournal(runtime, blocked);
  return {
    blocked,
    outcome: publicUpgradeResult(internalUpgradeResult(blocked)),
  };
}

function exposeJournal(runtime, journal) {
  const host = hostForControl(runtime.configService);
  const providerId = host.pipeline.controlProvider.id;
  const entries = structuredClone(host.layerData.get(providerId));
  entries._weaver.upgrades.journal[journal.runId] = journal;
  host.layerData.set(providerId, entries);
  host.pipeline.contracts.install(host.pipeline.contracts.prepare(entries._weaver));
}

function projectedJournal(runtime, runId) {
  return controlProjection(runtime.configService).prepared().configuration.upgrades.journal[runId];
}

async function request(transport, admin) {
  return transport.restAdapter.handleRequest("GET", "/v1/admin/upgrades/status", {
    params: {}, query: {}, headers: { origin: "https://admin.example" },
    ...(admin ? { authContext: adminContext() } : {}),
  });
}

function adminContext() {
  return {
    identity: { userId: "operator", roles: ["admin"] },
    isAdmin: true,
    isService: false,
    isUser: true,
  };
}

function assertUpgradeHeaders(headers, cors) {
  assert.deepEqual(headers, {
    "Content-Type": "application/json",
    ...(cors ? {
      "Access-Control-Allow-Origin": "https://admin.example",
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    } : {}),
  });
}

function assertPublic(value) {
  const text = JSON.stringify(value);
  for (const fragment of ["/home/user/secret", "mongodb://", "user:pass", "operator-token", "SecretReference", "\u001b", "stack\\nline"])
    assert.equal(text.includes(fragment), false, fragment);
  assert.ok(text.length < 4096);
}

function planRequest(runtime, initialization) {
  const sourceCatalog = { registrations: Object.fromEntries(initialization.registrations.map((request) => { const record = initialRegistrationRecord(request); return [internalRegistrationId(record), record]; })) };
  const record = { version: 1, kind: "service", request: { ...initialization.registrations[0], schema: targetSchema }, audit: { actor: "planner" } };
  const targetCatalog = { registrations: { [internalRegistrationId(record)]: record } };
  return { version: 1, expectedAuthorityRevision: runtime.configService.revision, sourceCatalogDigest: digest(sourceCatalog), inventoryRevision: "0", infrastructureGeneration: "g1", target: { catalogDigest: digest(targetCatalog), registrations: targetCatalog.registrations } };
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}

function validRouteBody(path) {
  return path.endsWith("recover")
    ? { version: 1, runId: crypto.randomUUID() }
    : {
        version: 1,
        request: {
          version: 1,
          expectedAuthorityRevision: "authority-v1.0",
          sourceCatalogDigest: "0".repeat(64),
          inventoryRevision: "0",
          infrastructureGeneration: "g1",
          target: { catalogDigest: "1".repeat(64), registrations: {} },
        },
      };
}
