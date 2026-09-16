import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deepGet, deepRemove, deepSet, parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  internalRegistrationId,
  internalUpgradeLayerDigest,
  internalUpgradePlanSchema,
} from "@weaver-conf/config-types";
import { getProviderRevision } from "@weaver-conf/storage-providers";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { initialRegistrationRecord } from "../src/bootstrap/initial-registrations.ts";
import { controlTransaction, hostForControl } from "../src/core/config-service-internal.ts";
import { transitionDigest } from "../src/core/schema-transition.ts";
import { openWeaverRuntime } from "../src/server-runtime.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";

const sourceSchema = objectSchema({ keep: { type: "boolean" } });
const targetSchema = objectSchema({
  keep: { type: "boolean" },
  port: { type: "integer", default: 41 },
});

export async function createTwoProviderFixture() {
  const fixture = await createStandaloneFixture({ schemas: { alpha: sourceSchema, beta: sourceSchema } });
  const request = structuredClone(fixture.request);
  request.generation.layout.layers.push({
    name: "secondary",
    type: "static",
    providerId: "secondary",
    config: { mergeId: "deep" },
  });
  request.generation.providers.push({
    id: "secondary",
    factory: "fs",
    options: { filePath: `${fixture.directory}/secondary/entries.json` },
  });
  await initializeWeaver(fixture.seed, request, fixture.administrator, {
    credentials: fixture.credentials,
  });
  return {
    ...fixture,
    request,
    open: () => openWeaverRuntime(fixture.seed, { credentials: fixture.credentials }),
  };
}

export async function installTwoProviderPlan(runtime, fixture, options = {}) {
  await seedTwoProviderSource(runtime);
  await runtime.configService.flush();
  const request = twoProviderRequest(runtime, fixture.request);
  const preview = await runtime.planUpgrade(request);
  assert.equal(preview.result.status, "ready", canonicalInternalJson(preview));
  const envelopes = await readEnvelopes(runtime);
  const plan = buildTwoProviderPlan(preview.result.plan, envelopes, options);
  await storeProtectedPlan(runtime, plan);
  return {
    plan,
    request: { ...request, expectedAuthorityRevision: runtime.configService.revision },
  };
}

export async function storeProtectedPlan(runtime, plan) {
  const host = hostForControl(runtime.configService);
  host.suspendApplication();
  try {
    const write = await controlTransaction(runtime.configService, "maintenance", ({ write }) =>
      write(`_weaver.upgrades.plans.${plan.id}`, plan, {
        expectedRevision: runtime.configService.revision,
      }));
    assert.equal(write.success, true);
  } finally {
    host.openApplication();
  }
}

export async function rawState(runtime) {
  const providers = hostForControl(runtime.configService).providers;
  return Object.fromEntries(await Promise.all(providers.map(async (provider) => [
    provider.id,
    await provider.authority.readLayer(provider.layer),
  ])));
}

export function journalFrom(state, runId) {
  return state.control.entries._weaver.upgrades.journal[runId];
}

function buildTwoProviderPlan(source, envelopes, options) {
  const placements = options.placements ?? ["platform", "secondary"];
  const reassigned = source.steps.map((step, index) => {
    const provider = placements[index];
    const envelope = envelopes.get(provider);
    const body = {
      ...step,
      target: {
        ...step.target,
        providerId: provider,
        namespace: source.finalLayers.find((layer) => layer.providerId === provider).namespace,
        storeId: envelope.storeId,
        layer: provider,
      },
      expectedRevision: getProviderRevision(envelope),
      ...(options.malicious && index === 0
        ? {
            mutation: { action: "set", value: { keep: false, port: 41 } },
            postDigest: transitionDigest({
              absent: false,
              value: { keep: false, port: 41 },
            }),
          }
        : {}),
    };
    delete body.id;
    return { id: `s${digest(body).slice(0, 31)}`, ...body };
  }).sort((a, b) => canonicalInternalJson(a.target).localeCompare(canonicalInternalJson(b.target)));
  const simulated = new Map([...envelopes].map(([id, value]) => [id, structuredClone(value.entries)]));
  for (const step of reassigned) applyStep(simulated.get(step.target.providerId), step);
  const sourceBinding = structuredClone(source.source);
  if (options.stale) {
    const binding = sourceBinding.providerRevisions.find((item) => item.providerId === "secondary");
    assert.ok(binding?.revisions[0]);
    binding.revisions[0].sequence = String(BigInt(binding.revisions[0].sequence) + 1n);
  }
  const body = {
    ...source,
    source: sourceBinding,
    steps: reassigned,
    finalLayers: source.finalLayers.map((layer) => ({
      ...layer,
      finalDigest: internalUpgradeLayerDigest(
        simulated.get(layer.providerId),
        layer.contentDomain,
      ),
    })),
  };
  delete body.id;
  return internalUpgradePlanSchema.parse({ ...body, id: digest(body) });
}

export async function seedTwoProviderSource(runtime) {
  for (const layer of ["platform", "secondary"])
    for (const key of ["alpha", "beta"])
      assert.equal(
        (await runtime.configService.set(layer, key, { keep: true })).success,
        true,
      );
}

function applyStep(entries, step) {
  assert.ok(entries);
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  const previous = deepGet(entries, key);
  assert.equal(step.preDigest, transitionDigest({
    absent: previous === undefined,
    ...(previous === undefined ? {} : { value: previous }),
  }));
  if (step.mutation.action === "remove") deepRemove(entries, key);
  else deepSet(entries, key, structuredClone(step.mutation.value));
}

async function readEnvelopes(runtime) {
  return new Map(await Promise.all(
    hostForControl(runtime.configService).providers.map(async (provider) => [
      provider.id,
      await provider.authority.readLayer(provider.layer),
    ]),
  ));
}

export function twoProviderRequest(runtime, initialization) {
  const sourceCatalog = catalog(initialization, sourceSchema);
  const targetCatalog = catalog(initialization, targetSchema);
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

function catalog(initialization, schema) {
  return {
    registrations: Object.fromEntries(initialization.registrations.map((request) => {
      const record = initialRegistrationRecord({ ...request, schema });
      return [internalRegistrationId(record), record];
    })),
  };
}

function objectSchema(properties) {
  return { type: "object", properties, additionalProperties: false };
}

function digest(value) {
  return createHash("sha256").update(canonicalInternalJson(value)).digest("hex");
}
