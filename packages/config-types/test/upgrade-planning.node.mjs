import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  canonicalInternalJson,
  internalUpgradePlannerInputSchema,
  internalUpgradePlanSchema,
  internalUpgradePlanResultSchema,
  internalUpgradePlanRequestSchema,
  internalUpgradePlanResponseSchema,
  internalUpgradeProviderBindingSchema,
  registeredConfigurationSchemaSchema,
  sha256Hex,
} from "../src/index.ts";

const digest = "a".repeat(64);
const request = {
  version: 1,
  expectedAuthorityRevision: "authority-v1.test",
  sourceCatalogDigest: digest,
  inventoryRevision: "0",
  infrastructureGeneration: "g1",
  target: { catalogDigest: digest, registrations: {} },
};

test("upgrade request and response contracts are strict", () => {
  assert.equal(internalUpgradePlanRequestSchema.safeParse(request).success, true);
  assert.equal(
    internalUpgradePlanRequestSchema.safeParse({ ...request, unknown: true }).success,
    false,
  );
  assert.equal(
    internalUpgradePlanResponseSchema.safeParse({
      version: 1,
      authorityRevision: "authority-v1.test",
      result: { status: "blocked", refusals: [{ code: "stale-binding", message: "stale" }] },
      unknown: true,
    }).success,
    false,
  );
});

test("upgrade plan contract verifies its canonical identity", () => {
  const revision = { storeId: "fs:data", environment: "dev", layer: "base", epoch: "11111111-1111-4111-8111-111111111111", sequence: "0" };
  const authority = {
    providerId: "disk",
    namespace: "fs:/data",
    contentDomain: "layer-entries-v1",
    revision,
  };
  const body = {
    version: 1,
    source: { catalogDigest: digest, dataDigests: [{ providerId: authority.providerId, namespace: authority.namespace, storeId: authority.revision.storeId, layer: authority.revision.layer, contentDomain: authority.contentDomain, digest }], providerRevisions: [{ providerId: authority.providerId, revisions: [authority.revision] }], inventoryRevision: "0", infrastructureGeneration: "g1" },
    target: { catalogDigest: digest },
    contexts: [[]],
    steps: [],
    finalLayers: [{ providerId: authority.providerId, namespace: authority.namespace, storeId: authority.revision.storeId, environment: authority.revision.environment, layer: authority.revision.layer, contentDomain: authority.contentDomain, sourceDigest: digest, finalDigest: digest }],
    refusals: [],
  };
  assert.equal(internalUpgradePlanSchema.safeParse({ ...body, id: "0".repeat(64) }).success, false);
  assert.equal(internalUpgradePlanResultSchema.safeParse({ status: "ready", plan: { ...body, id: "0".repeat(64) } }).success, false);
  const id = sha256Hex(canonicalInternalJson(body));
  assert.equal(internalUpgradePlanSchema.safeParse({ ...body, id }).success, true);
  const mutations = [
    (candidate) => { candidate.source.dataDigests[0].namespace = "fs:/other"; },
    (candidate) => { candidate.source.dataDigests[0].contentDomain = "control-application-v1"; },
    (candidate) => { candidate.finalLayers[0].namespace = "fs:/other"; },
    (candidate) => { candidate.finalLayers[0].contentDomain = "control-application-v1"; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(body);
    mutate(candidate);
    const mutatedId = sha256Hex(canonicalInternalJson(candidate));
    assert.notEqual(mutatedId, id);
    assert.equal(internalUpgradePlanSchema.safeParse({ ...candidate, id: mutatedId }).success, false);
  }
});

test("portable SHA-256 matches the standard digest vectors", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const unicode = "Weaver 🧵 ".repeat(10_000);
  assert.equal(
    sha256Hex(unicode),
    createHash("sha256").update(unicode).digest("hex"),
  );
});

test("provider namespace must equal its authority namespace", () => {
  const provider = {
    providerId: "disk",
    namespace: "forged",
    writable: true,
    capabilities: { kind: "durable-exclusive", durability: "local-fsync", namespace: "real", maxEnvelopeBytes: 100, scopedIO: "complete" },
    layers: [{ revision: { storeId: "store", environment: "dev", layer: "base", epoch: "11111111-1111-4111-8111-111111111111", sequence: "0" }, entries: {} }],
  };
  const parsed = internalUpgradeProviderBindingSchema.safeParse(provider);
  assert.equal(parsed.success, false);
});

test("secret markers cannot enter planner schema contracts", () => {
  assert.equal(
    registeredConfigurationSchemaSchema.safeParse({
      type: "object",
      properties: {
        secret: {
          type: "object",
          default: {
            _weaver: "secret-ref",
            provider: "vault",
            uri: "secret/path",
          },
        },
      },
    }).success,
    false,
  );
});

test("planner input rejects contradictory or unknown nested records", () => {
  assert.equal(
    internalUpgradePlannerInputSchema.safeParse({
      version: 1,
      request,
      authorityRevision: "authority-v1.test",
      sourceCatalog: { registrations: {} },
      sourceCatalogDigest: digest,
      targetCatalog: { registrations: {} },
      targetCatalogDigest: digest,
      schemas: [{ path: "/svc", environment: "dev" }],
      inventory: { version: 1, revision: "0", contexts: {} },
      infrastructureGenerationId: "g1",
      infrastructure: {},
      providers: [],
    }).success,
    false,
  );
});
