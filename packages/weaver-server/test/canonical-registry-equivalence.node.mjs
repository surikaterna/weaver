import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { createSchemaRegistry, createPersistentSchemaRegistry } from "../src/core/schema-registry.ts";
import frozen from "../../config-registry/test/fixtures/frozen-outcomes.json" with { type: "json" };
import { digest, outcome, requests, service } from "../../config-registry/test/fixtures/requests.mjs";

async function harness(persistent, initialEntries = {}) {
  const provider = createInMemoryStorageProvider({ id: "platform", layer: "platform", initialEntries });
  const configService = await createWeaverConfigService({ providers: [provider], environment: "dev" });
  const registry = persistent ? await createPersistentSchemaRegistry({ configService }) : createSchemaRegistry({ configService });
  return { provider, configService, registry };
}

async function checkpoint(registry, result) {
  const identities = registry.listRegisteredSchemaIdentities();
  const reads = [];
  for (const identity of identities.anchors) {
    reads.push({
      detail: registry.getRegisteredSchema(identity.path, identity.environment),
      anchor: await registry.resolveAnchor(`${identity.path}/name`, identity.environment),
    });
  }
  return digest({ result: outcome(result), identities, reads });
}

for (const persistent of [false, true]) {
  test(`${persistent ? "persistent" : "transient"} factory outcomes/read projections/private codec equal frozen server`, async () => {
    const subject = await harness(persistent);
    assert.equal(requests().length, frozen.server.length);
    for (const [index, request] of requests().entries()) {
      const actual = await subject.registry.register(request);
      assert.equal(await checkpoint(subject.registry, actual), frozen.server[index], `frozen server request ${index}`);
    }
    assert.equal(await subject.configService.get("_weaver.registry.schemas"), undefined);
    if (persistent) await checkRestart(subject);
    else assert.deepEqual((await subject.provider.load()).entries, {});
  });
}

async function checkRestart(subject) {
  const bytes = (await subject.provider.load()).entries._weaver.registry.schemas;
  assert.equal(digest(bytes), frozen.bytes);
  assert.equal(digest(JSON.stringify(bytes)), frozen.bytesRaw);
  assert.equal(bytes.version, 2);
  const nextService = await createWeaverConfigService({ providers: [subject.provider], environment: "dev" });
  const next = await createPersistentSchemaRegistry({ configService: nextService });
  assert.equal(digest(next.listRegisteredSchemaIdentities()), frozen.restart);
  assert.deepEqual(next.getRegisteredSchema("/svc/plugins/p", "prod/dev:x"), subject.registry.getRegisteredSchema("/svc/plugins/p", "prod/dev:x"));
  const legacy = { _weaver: { registry: { schemas: { environments: bytes.environments } } } };
  const restored = await harness(true, legacy);
  assert.equal(digest(restored.registry.listRegisteredSchemaIdentities()), frozen.legacy);
  assert.equal((await restored.registry.register(service("new"))).success, true);
  const upgraded = (await restored.provider.load()).entries._weaver.registry.schemas;
  assert.equal(digest(upgraded), frozen.upgradedBytes);
  assert.equal(digest(JSON.stringify(upgraded)), frozen.upgradedBytesRaw);
}
