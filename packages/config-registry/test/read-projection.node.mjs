import assert from "node:assert/strict";
import { test } from "node:test";
import * as support from "../dist/index.js";
import * as engine from "@weaver-conf/config-engine";
import { hydratedConfigurationInspectionSchema } from "@weaver-conf/config-types";
import { exerciseProjection } from "./read-projection-fixture.mjs";

test("registered effective/raw/namespace/publication surfaces share canonical policy and provenance", () => {
  const { projection, context } = exerciseProjection(support, engine);
  for (const key of ["public", "missing", "sensitive", "secret"])
    assert.ok(hydratedConfigurationInspectionSchema.safeParse(projection.inspect(`/example/settings/${key}`)).success);
  context.identity.environment = "other";
  context.revision = "changed";
  assert.equal(projection.inspect("/example/settings/public").identity.environment, "test");
  assert.equal(projection.inspect("/example/settings/public").revision, "revision-1");
  assert.throws(() => { projection.entries().example.settings.public = "changed"; }, TypeError);
  const withDefault = (path, fallback) => projection.get(path) ?? fallback;
  assert.equal(withDefault("/example/settings/missing", "default"), "default");
  assert.throws(() => withDefault("/example/settings/sensitive", "default"), { code: "FORBIDDEN" });
});

test("snapshot issuance authenticates before any supplied fields or context getters", () => {
  const { reader, snapshot, context } = exerciseProjection(support, engine);
  let getters = 0;
  const forged = { get entries() { getters++; return snapshot.entries; }, get layers() { getters++; return snapshot.layers; } };
  for (const handle of [forged, { ...snapshot }, structuredClone(snapshot), engine.configurationSnapshotSchema.parse(snapshot)])
    assert.throws(() => support.createRegisteredReadProjection(reader, handle, context), { code: "VALIDATION_ERROR" });
  assert.equal(getters, 0);
  assert.throws(() => support.createRegisteredReadProjection(reader, snapshot, { get identity() { getters++; return context.identity; }, revision: "r" }), { code: "VALIDATION_ERROR" });
  assert.equal(getters, 0);
  const projection = support.createRegisteredReadProjection(reader, snapshot, context);
  const path = { get startsWith() { getters++; return () => true; }, toString() { getters++; return "/example"; } };
  assert.throws(() => projection.get(path), { code: "VALIDATION_ERROR" });
  assert.equal(getters, 0);
});

function fixture(schema, entries) {
  const reader = support.createCanonicalSchemaRegistry({ defaultEnvironment: "test" });
  const result = reader.register({ serviceId: "example", environment: "test", owner: { name: "host", contact: "host@example.org" }, schema, fragmentSlots: [] });
  assert.equal(result.success, true, JSON.stringify(result));
  const snapshot = engine.resolveConfigurationSnapshot({ configuredRanks: [0], ceilings: [], layers: [
    { layer: "base", providerId: "provider", rank: 0, entries: { example: entries } },
  ] });
  return support.createRegisteredReadProjection(reader, snapshot, { identity: { environment: "test", scopePath: [] }, revision: "r" });
}

test("arrays retain indices; compositions, patterns and schema-valued wildcard do not declassify", () => {
  const string = { type: "string" };
  const hidden = { type: "string", "x-weaver": { sensitive: true } };
  const object = { type: "object", properties: { public: string } };
  const projection = fixture({ type: "object", properties: {
    tuple: { type: "array", items: [string, hidden, string] },
    all: { type: "object", allOf: [object, { type: "object", properties: { secret: hidden } }] },
    any: { type: "object", anyOf: [object, { ...object, "x-weaver": { sensitive: true } }] },
    one: { type: "object", oneOf: [object, object] },
    pattern: { type: "object", patternProperties: { "^p": string, "^private": hidden } },
    wildcard: { type: "object", additionalProperties: string },
    unknownWildcard: { type: "object", additionalProperties: true },
  } }, { tuple: ["first", "hidden", "third"], all: { public: "yes", secret: "no" },
    any: { public: "no" }, one: { public: "no" }, pattern: { public: "yes", private: "no", unknown: "no" },
    wildcard: { literal: "yes" }, unknownWildcard: { unknown: "no" } });
  const tuple = projection.get("/example/tuple");
  assert.equal(tuple.length, 3);
  assert.equal(Object.hasOwn(tuple, 1), false);
  assert.deepEqual(JSON.parse(JSON.stringify(tuple)), ["first", null, "third"]);
  assert.deepEqual(projection.get("/example/all"), { public: "yes" });
  assert.throws(() => projection.get("/example/any/public"), { code: "FORBIDDEN" });
  assert.throws(() => projection.get("/example/one"), { code: "FORBIDDEN" });
  assert.deepEqual(projection.get("/example/pattern"), { public: "yes" });
  assert.deepEqual(projection.get("/example/wildcard"), { literal: "yes" });
  assert.deepEqual(projection.get("/example/unknownWildcard"), {});
});

test("shared values at public and sensitive paths have distinct contexts; references fail closed", () => {
  const shared = { public: "visible" };
  const object = { type: "object", properties: { public: { type: "string" } } };
  const projection = fixture({ type: "object", properties: {
    safe: object, denied: { ...object, "x-weaver": { sensitive: true } },
    mounts: { type: "object", additionalProperties: { type: "string" } },
  } }, { safe: shared, denied: shared, mounts: {
    internal: { _weaver: "mount", source: "_weaver.providers" },
    unknown: { _weaver: "mount", source: "example.unknown" },
    ancestor: { _weaver: "mount", source: "example" },
    a: { _weaver: "mount", source: "example.mounts.b" },
    b: { _weaver: "mount", source: "example.mounts.a" },
  } });
  assert.deepEqual(projection.get("/example/safe"), shared);
  assert.throws(() => projection.get("/example/denied/public"), { code: "FORBIDDEN" });
  for (const key of ["internal", "unknown", "ancestor", "a", "b"])
    assert.throws(() => projection.get(`/example/mounts/${key}`), { code: "FORBIDDEN" });
  assert.deepEqual(projection.entries().example.mounts, {});
});

test("environment and ordered scope tuples stay immutable and operation-local", () => {
  const { reader, snapshot } = exerciseProjection(support, engine);
  const orders = [
    [{ scopeId: "tenant", value: "a:雪" }, { scopeId: "site", value: "b" }],
    [{ scopeId: "site", value: "b" }, { scopeId: "tenant", value: "a:雪" }],
  ];
  for (const environment of ["test", "other"]) {
    for (const scopePath of orders) {
      const identity = { environment, scopePath: structuredClone(scopePath) };
      const projection = support.createRegisteredReadProjection(reader, snapshot, { identity, revision: "r" });
      const inspection = projection.inspect("/example/settings/public");
      identity.scopePath[0].value = "changed";
      assert.deepEqual(inspection.identity.scopePath, scopePath);
      assert.equal(inspection.identity.environment, environment);
      assert.ok(Object.isFrozen(inspection.identity.scopePath[0]));
    }
  }
});

test("pre-resolved aliases require public source proof across raw and effective graphs", () => {
  const { reader } = exerciseProjection(support, engine);
  const snapshot = engine.resolveConfigurationSnapshot({ configuredRanks: [0, 1], ceilings: [], layers: [
    { layer: "base", providerId: "base", rank: 0, entries: { example: { settings: {
      public: "public source", sensitive: "sensitive payload",
      alias: { _weaver: "mount", source: "example.settings.public" },
    } } } },
    { layer: "resolved", providerId: "resolved", rank: 1, entries: { example: { settings: { alias: "resolved public" } } } },
  ] });
  const context = { identity: { environment: "test", scopePath: [] }, revision: "r" };
  const projection = support.createRegisteredReadProjection(reader, snapshot, context);
  assert.equal(projection.get("/example/settings/alias"), "resolved public");
  assert.equal(projection.inspect("/example/settings/alias").contributions[0].state, "redacted");
  for (const source of ["example.settings.sensitive", "example.settings.unknown", "example", "_weaver.providers"]) {
    const unsafe = engine.resolveConfigurationSnapshot({ configuredRanks: [0, 1], ceilings: [], layers: [
      { ...snapshot.layers[0], entries: { example: { settings: { public: "source", sensitive: "payload", alias: { _weaver: "mount", source } } } } },
      snapshot.layers[1],
    ] });
    const denied = support.createRegisteredReadProjection(reader, unsafe, context);
    assert.throws(() => denied.get("/example/settings/alias"), { code: "FORBIDDEN" });
    assert.equal(denied.inspect("/example/settings/alias").effective.state, "redacted");
  }
});

test("fragment transitions cannot regrant a sensitive ancestor and reserved literals cannot grant reads", () => {
  const reader = support.createCanonicalSchemaRegistry({ defaultEnvironment: "test" });
  const owner = { name: "host", contact: "host@example.org" };
  assert.equal(reader.register({ serviceId: "example", environment: "test", owner, fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
    schema: { type: "object", properties: { plugins: { type: "object", "x-weaver": { sensitive: true } },
      data: { type: "object", additionalProperties: { type: "string" } } } } }).success, true);
  assert.equal(reader.register({ serviceId: "example", environment: "test", owner, slotPath: "/plugins", providerId: "panel",
    schema: { type: "object", properties: { enabled: { type: "boolean" } } } }).success, true);
  const data = JSON.parse('{"public":"yes","constructor":"inert","prototype":"inert","__proto__":"inert"}');
  const snapshot = engine.resolveConfigurationSnapshot({ configuredRanks: [0], ceilings: [], layers: [
    { layer: "base", providerId: "provider", rank: 0, entries: { example: { plugins: { panel: { enabled: true } }, data } } },
  ] });
  const projection = support.createRegisteredReadProjection(reader, snapshot, { identity: { environment: "test", scopePath: [] }, revision: "r" });
  assert.throws(() => projection.get("/example/plugins/panel/enabled"), { code: "FORBIDDEN" });
  assert.deepEqual(projection.get("/example/data"), { public: "yes" });
  assert.equal(Object.hasOwn(data, "constructor"), true);
});

test("deep context lookup does not invoke recursive write support or expand ancestor paths", () => {
  let data = "leaf";
  for (let index = 0; index < 10000; index++) data = { child: data };
  const projection = fixture({ type: "object", properties: { tree: { type: "object" } } }, { tree: data });
  const path = `/example/tree/${Array(10000).fill("child").join("/")}`;
  assert.throws(() => projection.get(path), { code: "SCHEMA_NOT_REGISTERED" });
  assert.deepEqual(projection.get("/example/tree"), {});
});

test("missing alternatives retain declaration evidence without defaulting through denial", () => {
  const publicBranch = { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] };
  const other = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  const projection = fixture({ type: "object", properties: {
    public: { type: "object", anyOf: [publicBranch, other] },
    denied: { type: "object", anyOf: [publicBranch, { ...other, "x-weaver": { sensitive: true } }] },
  } }, { public: {}, denied: {} });
  assert.equal(projection.get("/example/public/enabled"), undefined);
  assert.equal(projection.inspect("/example/public/enabled").effective.state, "missing");
  assert.throws(() => projection.get("/example/denied/enabled"), { code: "FORBIDDEN" });
});

test("real registered shared schema/value DAG preserves only unique policy contexts", () => {
  let schema = { type: "object", properties: { value: { type: "string" } } };
  let value = { value: "leaf" };
  for (let index = 0; index < 100; index++) {
    schema = { type: "object", properties: { left: schema, right: schema } };
    value = { left: value, right: value };
  }
  const projection = fixture(schema, value);
  let current = projection.get("/example");
  const seen = new Set();
  for (let index = 0; index < 100; index++) {
    seen.add(current);
    assert.equal(current.left, current.right);
    assert.ok(Object.isFrozen(current));
    current = current.left;
  }
  seen.add(current);
  assert.equal(current.value, "leaf");
  assert.equal(seen.size, 101);
  assert.notEqual(projection.get("/example"), value);
});
