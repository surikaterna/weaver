import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanonicalSchemaRegistry, schemaRegistrationResultSchema } from "../dist/index.js";
import { createRegistryAdapter } from "../dist/internal/server-adapter.js";
import frozen from "./fixtures/frozen-outcomes.json" with { type: "json" };
import { digest, fragment, outcome, requests, service } from "./fixtures/requests.mjs";

test("canonical request outcomes and identities equal the frozen former evaluator", () => {
  const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "dev" });
  assert.equal(requests().length, frozen.canonical.length);
  for (const [index, request] of requests().entries()) {
    const actual = registry.register(request);
    assert.equal(digest({ result: outcome(actual), identities: registry.listRegisteredSchemaIdentities() }), frozen.canonical[index], `frozen request ${index}`);
    assert.equal(schemaRegistrationResultSchema.safeParse(actual).success, true);
  }
  assert.throws(() => registry.listAll(), { code: "SCHEMA_CONFLICT" });
  assert.equal(registry.getRegisteredSchema("/svc/plugins/p", "prod/dev:x").environment, "prod/dev:x");
  assert.equal(registry.getRegisteredSchema("/svc/plugins/p:prod/dev", "x").environment, "x");
  assert.equal(registry.resolveAnchor("/svc/literal.dot/😀/p.dot/name", "雪/e\u0301").kind, "fragment");
  assert.equal(registry.resolveAnchor("/svc-other/name"), null);
  assert.equal(registry.resolveAnchor("/_weaver/registry"), null);
  assert.equal(registry.getSchema("../escape", "dev"), null);
  assert.equal(registry.getRegisteredSchema("/svc", "missing"), null);
});

test("requests, successful results, all reads and pages are detached while shared graphs survive", () => {
  const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "dev" });
  const shared = { type: "string", default: { literal: "old" } };
  const request = service();
  request.schema.properties = { one: shared, two: shared };
  const result = registry.register(request);
  assert.equal(result.success, true);
  shared.default.literal = "caller";
  result.metadata.owner.name = "result";
  const schema = registry.getSchema("svc", "dev");
  assert.equal(schema.properties.one, schema.properties.two);
  assert.equal(schema.properties.one.default.literal, "old");
  schema.properties.one.default.literal = "read";
  registry.resolveAnchor("/svc/name").metadata.owner.name = "read";
  registry.getRegisteredSchema("/svc", "dev").schema.properties.one.default.literal = "detail";
  registry.listAll()["/svc:dev"].properties.one.default.literal = "all";
  registry.listRegisteredSchemaIdentities().slots[0].path = "list";
  registry.listRegisteredSchemaIdentityPage({ limit: 1 }).anchors[0].path = "page";
  assert.equal(registry.getSchema("svc", "dev").properties.one.default.literal, "old");
  assert.equal(registry.getRegisteredSchema("/svc", "dev").metadata.owner.name, "owner");
  assert.equal(registry.listRegisteredSchemaIdentityPage({ limit: 1 }).anchors[0].path, "/svc");
  const cyclic = service("cycle");
  cyclic.schema.properties.self = cyclic.schema;
  assert.equal(registry.register(cyclic).success, false);
  assert.equal(registry.register(fragment()).success, true);
  assert.equal(registry.resolveAnchor("/svc/plugins/p/name").path, "/svc/plugins/p");
});

test("staging cannot alias authority; unpublished and rejected candidates do not stale cursors", () => {
  const adapter = createRegistryAdapter({ defaultEnvironment: "dev" }, undefined, () => new Uint8Array(16).fill(7));
  adapter.prepare(service()).publish();
  const cursor = adapter.reader.listRegisteredSchemaIdentityPage({ limit: 1 }).nextCursor;
  const prepared = adapter.prepare(service("next"));
  prepared.candidate.schemas.clear();
  prepared.result.metadata.owner.name = "caller";
  assert.equal(adapter.reader.getSchema("svc", "next"), null);
  assert.equal(adapter.reader.listRegisteredSchemaIdentityPage({ cursor }).hasMore, false);
  assert.equal(adapter.prepare(fragment("unknown")).result.success, false);
  assert.doesNotThrow(() => adapter.reader.listRegisteredSchemaIdentityPage({ cursor }));
  prepared.publish();
  assert.equal(adapter.reader.getRegisteredSchema("/svc", "next").metadata.owner.name, "owner");
  assert.throws(() => adapter.reader.listRegisteredSchemaIdentityPage({ cursor }), { code: "REVISION_CONFLICT" });
  assert.throws(() => prepared.publish(), { code: "REVISION_CONFLICT" });
});
