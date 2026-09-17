import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  canonicalInternalJson,
  internalUpgradeLayerDigest,
} from "@weaver-conf/config-types";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { createControlService } from "../src/core/control-service.ts";
import { prepareTestService } from "./setup-service.ts";

const schema = {
  type: "object",
  properties: { enabled: { type: "boolean" } },
  additionalProperties: false,
};

test("untrusted provider alias cannot admit a retained upgrade plan", async () => {
  const original = createInMemoryStorageProvider({
    id: "application",
    layer: "application",
    environment: "dev",
  });
  let activeSubscriptions = 0;
  const provider = {
    id: original.id,
    layer: original.layer,
    writable: original.writable,
    authority: original.authority,
    capabilities: original.capabilities,
    load: () => original.load(),
    loadLayer: (layer) => original.loadLayer?.(layer),
    write: (key, value) => original.write(key, value),
    writeLayer: (layer, key, value) => original.writeLayer?.(layer, key, value),
    remove: (key) => original.remove(key),
    removeLayer: (layer, key) => original.removeLayer?.(layer, key),
    onExternalChange: () => {
      activeSubscriptions += 1;
      return () => {
        activeSubscriptions -= 1;
      };
    },
  };
  const options = await prepareTestService(
    { providers: [provider], environment: "dev" },
    { svc: schema },
  );
  const control = await createControlService(options);
  try {
    const source = await provider.authority.readLayer(provider.layer);
    const state = (await options.providers[0].load()).entries._weaver;
    const plan = createPlan(state, provider, source);
    const stored = await control.storePlan(plan, control.revision);
    assert.equal(stored.success, true, stored.error?.message);
  } finally {
    await control.close();
  }
  const before = await snapshots(options.providers);
  await assert.rejects(createWeaverConfigService(options), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.message, /provider definition/);
    return true;
  });
  assert.deepEqual(await snapshots(options.providers), before);
  assert.equal(activeSubscriptions, 0);
});

function createPlan(state, provider, source) {
  const namespace = provider.authority.capabilities.namespace;
  const digest = internalUpgradeLayerDigest(source.entries, "layer-entries-v1");
  const body = {
    version: 1,
    source: {
      catalogDigest: createHash("sha256")
        .update(canonicalInternalJson(state.catalog))
        .digest("hex"),
      dataDigests: [{
        providerId: provider.id,
        namespace,
        storeId: source.storeId,
        layer: source.layer,
        contentDomain: "layer-entries-v1",
        digest,
      }],
      providerRevisions: [{ providerId: provider.id, revisions: [{
        storeId: source.storeId,
        environment: source.environment,
        layer: source.layer,
        epoch: source.epoch,
        sequence: source.sequence,
      }] }],
      inventoryRevision: state.scopeInventory.revision,
      infrastructureGeneration: state.infrastructure.activeGeneration,
    },
    target: { catalogDigest: createHash("sha256").update("target").digest("hex") },
    contexts: [[]],
    steps: [],
    finalLayers: [{
      providerId: provider.id,
      namespace,
      storeId: source.storeId,
      environment: source.environment,
      layer: source.layer,
      contentDomain: "layer-entries-v1",
      sourceDigest: digest,
      finalDigest: digest,
    }],
    refusals: [],
  };
  return {
    ...body,
    id: createHash("sha256").update(canonicalInternalJson(body)).digest("hex"),
  };
}

async function snapshots(providers) {
  return Promise.all(
    providers.map(async (provider) => ({
      id: provider.id,
      inventory: await provider.authority?.inventory(),
      layer: await provider.authority?.readLayer(provider.layer),
    })),
  );
}
