import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  canonicalInternalJson,
  internalRegistrationId,
} from "@weaver-conf/config-types";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import { authoritativeContextPaths } from "../src/core/candidate-scopes.ts";
import { scopeContextId } from "../src/core/scope-inventory.ts";
import { hostForControl } from "../src/core/config-service-internal.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";

const sourceSchema = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    label: { type: "string" },
    inherited: { type: "string" },
    recursiveReference: { type: "string" },
    secret: { type: "string" },
  },
  additionalProperties: false,
};
const targetSchema = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    label: { type: "string" },
    inherited: { type: "string" },
    recursiveReference: { type: "string" },
    secret: { type: "string" },
    port: { type: "integer", default: 41 },
  },
  additionalProperties: false,
};
const regionUs = [{ scopeId: "region", value: "us" }];
const tenantOne = [...regionUs, { scopeId: "tenant", value: "one" }];
const tenantTwo = [...regionUs, { scopeId: "tenant", value: "two" }];
const regionEu = [{ scopeId: "region", value: "eu" }];

test("authoritative contexts include base and each full lifecycle path once in canonical order", () => {
  const paths = [tenantTwo, regionEu, tenantOne, regionUs];
  const prepared = preparedInventory(paths);
  prepared.configuration.scopeInventory.contexts[
    scopeContextId(regionEu)
  ].state = "retired";
  const actual = authoritativeContextPaths(prepared, [
    tenantOne,
    [],
    regionUs,
    regionEu,
    tenantTwo,
  ]);
  assert.deepEqual(
    actual,
    [[], regionEu, tenantOne, tenantTwo, regionUs],
  );
  assert.deepEqual(new Set(actual.map(scopeContextId)).size, 5);
});

test("authoritative contexts reject omitted, duplicate, and aliased identities", () => {
  const prepared = preparedInventory([regionUs, tenantOne]);
  assert.throws(
    () => authoritativeContextPaths(prepared, [[], regionUs]),
    { code: "REVISION_CONFLICT" },
  );
  assert.throws(
    () => authoritativeContextPaths(prepared, [[], regionUs, regionUs]),
    { code: "REVISION_CONFLICT" },
  );
  const alias = preparedInventory([regionUs]);
  alias.configuration.scopeInventory.contexts.deadbeef =
    alias.configuration.scopeInventory.contexts[scopeContextId(regionUs)];
  delete alias.configuration.scopeInventory.contexts[scopeContextId(regionUs)];
  assert.throws(() => authoritativeContextPaths(alias), {
    code: "VALIDATION_ERROR",
  });
});

test("apply binds exact base, active, retired, cold, multi-scope and inherited evidence once", { timeout: 30_000 }, async (t) => {
  const fixture = await createStandaloneFixture({
    schemas: {
      svc: sourceSchema,
      shared: { type: "object", additionalProperties: true },
    },
    paths: [regionUs, tenantOne, tenantTwo],
    retired: [regionEu],
  });
  let runtime;
  try {
    await initializeWeaver(
      fixture.seed,
      fixture.request,
      fixture.administrator,
      { credentials: fixture.credentials },
    );
    runtime = await openWeaverRuntime(fixture.seed, {
      credentials: fixture.credentials,
      secretBackend: { resolve: async ({ uri }) => `resolved:${uri}` },
    });
    const applied = await assertSuccessApply(t, runtime, fixture.request);
    await runtime.close();
    runtime = await assertFreshRecovery(t, fixture, applied);
  } finally {
    t.mock.restoreAll();
    await runtime?.close();
    await fixture.dispose();
  }
});

async function assertSuccessApply(t, runtime, initialization) {
  await seedScopedValues(runtime);
  await runtime.configService.flush();
  const observed = observeFinalValidation(t, runtime);
  const events = [];
  const unsubscribe = runtime.configService.onDelta((event) => events.push(event));
  const subscriptions = hostForControl(runtime.configService).providers.flatMap((item) =>
    item.onExternalChange ? [t.mock.method(item, "onExternalChange")] : [],
  );
  const lifecycle = lifecycleValues(runtime);
  const request = planRequest(runtime, initialization, "0");
  const preview = await runtime.planUpgrade(request);
  assert.equal(preview.result.status, "ready", canonicalInternalJson(preview));
  request.expectedAuthorityRevision = preview.authorityRevision;
  const applied = await runtime.applyUpgrade({ version: 1, request });
  unsubscribe();
  assert.equal(applied.status, "completed", canonicalInternalJson(applied));
  const journal = await appliedJournal(runtime);
  await assertAppliedEvidence(runtime, observed, events, subscriptions, lifecycle, journal);
  return { contexts: structuredClone(observed.final[0]), journal, lifecycle };
}

function observeFinalValidation(t, runtime) {
  const host = hostForControl(runtime.configService);
  const validate = host.pipeline.validate.bind(host.pipeline);
  const resolve = host.runtime.resolveCandidate.bind(host.runtime);
  const observed = { final: [], validator: undefined };
  t.mock.method(host.runtime, "resolveCandidate", (raw) =>
    resolveFinalCandidate(raw, resolve),
  );
  t.mock.method(host.pipeline, "validate", async (...arguments_) => {
    const result = await validate(...arguments_);
    if (arguments_[2]) {
      observed.validator = result.contexts;
      observed.final.push(structuredClone(result.contexts));
    }
    return result;
  });
  return observed;
}

async function assertAppliedEvidence(runtime, observed, events, subscriptions, lifecycle, journal) {
  assert.equal(observed.final.length, 1);
  const contexts = observed.final[0];
  assert.deepEqual(contexts.map((item) => item.scopePath), [[], regionEu, tenantOne, tenantTwo, regionUs]);
  assert.equal(new Set(contexts.map((item) => scopeContextId(item.scopePath))).size, 5);
  assertEvidenceObjects(contexts);
  assert.equal(journal.activation.finalContexts.runId, journal.runId);
  assertBindingMatchesValidated(journal.activation.finalContexts, contexts);
  observed.validator[0].entries.svc.port = 99;
  assert.deepEqual(await runtime.configService.get("svc"), contexts[0].entries.svc);
  for (const path of [regionUs, tenantOne]) {
    const expected = contexts.find((item) => scopeContextId(item.scopePath) === scopeContextId(path));
    assert.deepEqual(await runtime.configService.get("svc", { scopePath: path }), expected.entries.svc);
  }
  assert.deepEqual(lifecycleValues(runtime), lifecycle);
  assert.equal(events.some((event) => isLifecycleEventFor(event, regionEu)), false);
  assert.equal(events.some((event) => isLifecycleEventFor(event, tenantTwo)), false);
  assert.equal(subscriptions.reduce((count, item) => count + item.mock.callCount(), 0), 0);
}

async function assertFreshRecovery(t, fixture, applied) {
  const runtime = await openWeaverRuntime(fixture.seed, {
    credentials: fixture.credentials,
    secretBackend: { resolve: async ({ uri }) => `resolved:${uri}` },
  });
  const events = [];
  const unsubscribe = runtime.configService.onDelta((event) => events.push(event));
  await runtime.enterMaintenance();
  const host = hostForControl(runtime.configService);
  const resolve = host.runtime.resolveCandidate.bind(host.runtime);
  t.mock.method(host.runtime, "resolveCandidate", (raw) => resolveFinalCandidate(raw, resolve));
  const install = t.mock.method(host, "installUpgradeSnapshot");
  const open = t.mock.method(host, "openApplication");
  const resume = t.mock.method(host.maintenance, "resume");
  for (let attempt = 0; attempt < 3; attempt++)
    assert.equal((await runtime.recoverUpgrade({ version: 1, runId: applied.journal.runId })).status, "completed");
  unsubscribe();
  assert.deepEqual([install.mock.callCount(), open.mock.callCount(), resume.mock.callCount()], [1, 1, 1]);
  assert.equal(events.length, 0);
  assert.deepEqual(await runtime.configService.get("svc"), applied.contexts[0].entries.svc);
  assert.deepEqual(lifecycleValues(runtime), applied.lifecycle);
  return runtime;
}

async function seedScopedValues(runtime) {
  await requireWrite(runtime.configService.set("platform", "shared.reference", "resolved-reference"));
  await requireWrite(runtime.configService.set("region", "shared.regionLayer", "stable"));
  await requireWrite(runtime.configService.set("tenant", "shared.tenantLayer", "stable"));
  await requireWrite(runtime.configService.set("platform", "svc.keep", true));
  await requireWrite(runtime.configService.set("platform", "svc.inherited", "base"));
  await requireWrite(runtime.configService.set("platform", "svc.recursiveReference", "reference-token"));
  await requireWrite(runtime.configService.set("platform", "svc.secret", "secret-token"));
  await requireWrite(
    runtime.configService.set("region:us", "svc.label", "region"),
  );
  await requireWrite(
    runtime.configService.set("tenant:one", "svc.label", "tenant"),
  );
}

function assertEvidenceObjects(contexts) {
  const byId = new Map(contexts.map((item) => [scopeContextId(item.scopePath), item.entries]));
  const base = {
    keep: true,
    inherited: "base",
    recursiveReference: "resolved-reference",
    secret: "resolved:svc/key",
    port: 41,
  };
  assert.deepEqual(byId.get(scopeContextId([])).svc, base);
  assert.deepEqual(byId.get(scopeContextId(regionEu)).svc, base);
  assert.deepEqual(byId.get(scopeContextId(regionUs)).svc.label, "region");
  assert.deepEqual(byId.get(scopeContextId(tenantOne)).svc.label, "tenant");
  assert.deepEqual(byId.get(scopeContextId(tenantTwo)).svc.label, "region");
  for (const entries of byId.values()) assert.equal(entries.svc.port, 41);
}

function resolveFinalCandidate(raw, resolveCandidate) {
  const candidate = structuredClone(raw);
  if (candidate.svc?.recursiveReference === "reference-token")
    candidate.svc.recursiveReference = {
      _weaver: "mount",
      source: "shared.reference",
    };
  if (candidate.svc?.secret === "secret-token")
    candidate.svc.secret = {
      _weaver: "secret-ref",
      provider: "vault",
      uri: "svc/key",
    };
  return resolveCandidate(candidate);
}

async function appliedJournal(runtime) {
  const control = runtime.configService.providers.find((item) => item.id === "control");
  const envelope = await control.authority.readLayer(control.layer);
  return Object.values(envelope.entries._weaver.upgrades.journal)[0];
}

function assertBindingMatchesValidated(binding, contexts) {
  for (const [index, context] of contexts.entries()) {
    const persisted = binding.contexts[index];
    const digest = createHash("sha256").update(canonicalInternalJson({
      domain: "weaver.final-context-delivered.v2",
      runId: binding.runId,
      nonce: binding.nonce,
      context: {
        id: persisted.id,
        scopePath: persisted.scopePath,
        authorityVector: persisted.authorityVector,
        prepared: context.entries,
        delivered: context.entries,
      },
    })).digest("hex");
    assert.equal(persisted.deliveredDigest, digest);
  }
}

function lifecycleValues(runtime) {
  return {
    region: runtime.scopeManager.listScopeValues("region"),
    tenant: runtime.scopeManager.listScopeValues("tenant"),
  };
}

function isLifecycleEventFor(event, scopePath) {
  return event?.scopePath && scopeContextId(event.scopePath) === scopeContextId(scopePath);
}

function preparedInventory(paths) {
  return {
    configuration: {
      scopeInventory: {
        version: 1,
        revision: "7",
        contexts: Object.fromEntries(
          paths.map((scopePath) => [
            scopeContextId(scopePath),
            { scopePath, state: "active" },
          ]),
        ),
      },
    },
  };
}

function planRequest(runtime, initialization, inventoryRevision) {
  const sourceCatalog = {
    registrations: Object.fromEntries(
      initialization.registrations.map((request) => {
        const record = initialRegistrationRecord(request);
        return [internalRegistrationId(record), record];
      }),
    ),
  };
  const registrations = Object.fromEntries(
    initialization.registrations.map((request) => {
      const record = {
        version: 1,
        kind: "service",
        request: {
          ...request,
          schema: request.serviceId === "svc" ? targetSchema : request.schema,
        },
        audit: { actor: "planner" },
      };
      return [internalRegistrationId(record), record];
    }),
  );
  return {
    version: 1,
    expectedAuthorityRevision: runtime.configService.revision,
    sourceCatalogDigest: digest(sourceCatalog),
    inventoryRevision,
    infrastructureGeneration: "g1",
    target: {
      catalogDigest: digest({ registrations }),
      registrations,
    },
  };
}

async function requireWrite(pending) {
  assert.equal((await pending).success, true);
}

function digest(value) {
  return createHash("sha256")
    .update(canonicalInternalJson(value))
    .digest("hex");
}
