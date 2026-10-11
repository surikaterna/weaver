import assert from "node:assert/strict";
import { test } from "node:test";
import {
  registeredMutationEvidence,
  registeredMutationFootprint,
  registeredMutationFootprintSchema,
} from "../dist/index.js";

test("footprints include removed and missing protected declarations but not unrelated patch siblings", () => {
  const schema = { type: "object", properties: {
    record: { type: ["object", "null"], properties: {
      public: { type: "number" }, hidden: { type: "string", "x-weaver": { sensitive: true } },
      missing: { type: "string", "x-weaver": { visibility: "internal" } },
    } }, sibling: { type: "string", "x-weaver": { sensitive: true } },
  } };
  const before = { record: { public: 1, hidden: "private" }, sibling: "unchanged" };
  const after = { record: null, sibling: "unchanged" };
  const footprint = registeredMutationFootprint(schema, ["record"], before, after);
  assert.ok(registeredMutationFootprintSchema.safeParse(footprint).success);
  const paths = new Map(footprint.map((item) => [item.path.join("/"), item]));
  assert.deepEqual([...paths.keys()].sort(), ["record", "record/hidden", "record/missing", "record/public"]);
  assert.equal(paths.get("record/hidden").before.sensitive, true);
  assert.equal(paths.get("record/missing").before.forbidden, true);
  const patch = registeredMutationFootprint(schema, ["record", "public"], before,
    { ...before, record: { ...before.record, public: 2 } });
  assert.deepEqual(patch.map((item) => item.path), [["record", "public"]]);
});

test("before and after branch evidence retains policy removed by a discriminator change", () => {
  const branch = (kind, sensitive) => ({ type: "object", required: ["kind"], properties: {
    kind: { type: "string", const: kind }, data: { type: "string", "x-weaver": { sensitive } },
  } });
  const schema = { type: "object", oneOf: [branch("private", true), branch("public", false)] };
  const footprint = registeredMutationFootprint(schema, [],
    { kind: "private", data: "secret" }, { kind: "public", data: "new" });
  const data = footprint.find((item) => item.path[0] === "data");
  assert.equal(data.before.sensitive, true);
  assert.equal(data.after.sensitive, false);
  assert.equal(data.before.ambiguous, false);
  assert.equal(data.after.ambiguous, false);
});

test("array member and ancestor policies survive explicit unconstrained descendants", () => {
  const schema = { type: "object", properties: { list: { type: "array",
    "x-weaver": { sensitive: true }, items: { type: "object", additionalProperties: true } } } };
  const before = { list: [{ nested: { value: 1 } }] };
  const evidence = registeredMutationEvidence(schema, ["list", "0", "nested", "value"], before);
  assert.equal(evidence.sensitive, true);
  assert.equal(evidence.unconstrained, true);
  assert.equal(evidence.declared, true);
  assert.equal(evidence.ancestors.some((item) => item.type === "array"), true);
});

test("footprint boundary rejects executable accessors and cycles without invoking them", () => {
  let calls = 0;
  const schema = { type: "object", additionalProperties: true };
  const getter = { get secret() { calls++; return "private"; } };
  assert.throws(() => registeredMutationFootprint(schema, [], getter, {}), { code: "VALIDATION_ERROR" });
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => registeredMutationFootprint(schema, [], cycle, {}), { code: "VALIDATION_ERROR" });
  const cyclicSchema = { type: "object", properties: {} }; cyclicSchema.properties.self = cyclicSchema;
  assert.throws(() => registeredMutationFootprint(cyclicSchema, [], {}, {}), { code: "VALIDATION_ERROR" });
  assert.equal(calls, 0);
});

test("footprints retain opaque reserved siblings as forbidden evidence rather than rejecting safe changes", () => {
  const schema = { type: "object", additionalProperties: true };
  const before = JSON.parse('{"safe":1,"opaque":{"__proto__":{"secret":"PRIVATE"},"constructor":2}}');
  const after = { ...before, safe: 2 };
  const changed = registeredMutationFootprint(schema, ["safe"], before, after);
  assert.deepEqual(changed.map((item) => item.path), [["safe"]]);
  assert.equal(changed[0].before.declared, true);
  assert.equal(changed[0].after.forbidden, false);
  const full = registeredMutationFootprint(schema, [], before, after);
  for (const key of ["__proto__", "constructor"])
    assert.equal(full.find((item) => item.path.join("/") === `opaque/${key}`).after.forbidden, true);
  assert.equal(before.opaque.__proto__.secret, "PRIVATE");
  assert.equal(Object.isFrozen(before), false);
});
