import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanonicalSchemaRegistry, createRegisteredReadProjection } from "../dist/index.js";
import { resolveConfigurationSnapshot } from "@weaver-conf/config-engine";

function fixture() {
  const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "east" });
  const child = { type: "object", properties: { value: { type: "string" } } };
  const request = { serviceId: "example", environment: "east", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: { type: "object", properties: {
    left: child, right: child, hidden: { type: "string", "x-weaver": { sensitive: true } }, internal: { type: "string", "x-weaver": { visibility: "internal" } }, secret: { type: "object", additionalProperties: true },
  } } };
  assert.equal(registry.register(request).success, true);
  const shared = { value: "same" };
  const raw = resolveConfigurationSnapshot({ configuredRanks: [0], ceilings: [], layers: [{ layer: "base", providerId: "p", rank: 0, entries: { example: {
    left: shared, right: shared, hidden: "PRIVATE", internal: "INTERNAL", secret: { _weaver: "secret-ref", key: "KEY" },
  } } }] });
  const context = { identity: { environment: "east", scopePath: [] }, revision: "r1" };
  return { registry, request, raw, context, projection: createRegisteredReadProjection(registry, raw, context) };
}

test("query-local access distinguishes paths sharing schema/data and never overrides hard denial", () => {
  const { projection } = fixture();
  const allow = () => true;
  assert.equal(projection.get("/example/hidden", allow), "PRIVATE");
  assert.throws(() => projection.get("/example/hidden"), { code: "FORBIDDEN" });
  for (const path of ["/example/internal", "/example/secret", "/example/secret/key"])
    assert.throws(() => projection.get(path, allow), { code: "FORBIDDEN" });
  const paths = [];
  const access = (evidence) => { paths.push(evidence.path); return !evidence.sensitive && !evidence.path.includes("right"); };
  assert.deepEqual(projection.get("/example", access), { left: { value: "same" } });
  assert.ok(paths.some((path) => path.join("/") === "example/right"));
  assert.equal(projection.get("/example/right/value", allow), "same");
  assert.equal(projection.inspect("/example/right/value", access).effective.state, "redacted");
  assert.throws(() => projection.get("/example/left", () => Promise.resolve(true)), { code: "FORBIDDEN" });
});

test("first authorized query uses generation-captured metadata rather than a subsequently changed registry", () => {
  const { projection, registry, request, raw, context } = fixture();
  request.schema.properties.left["x-weaver"] = { sensitive: true };
  assert.equal(registry.register(request).success, true);
  const next = createRegisteredReadProjection(registry, raw, { ...context, revision: "r2" });
  const publicOnly = (evidence) => !evidence.sensitive;
  assert.equal(projection.get("/example/left/value", publicOnly), "same");
  assert.throws(() => next.get("/example/left/value", publicOnly), { code: "FORBIDDEN" });
  assert.equal(projection.inspect("/example/left/value", publicOnly).revision, "r1");
  assert.equal(next.inspect("/example/left/value", publicOnly).revision, "r2");
});
