import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateEffectiveConfiguration } from "@weaver-conf/config-engine";
import { schemaWriteSupport, structuralSupportSchema } from "../dist/index.js";
import { reverseSafety, safetyLedger } from "./structural-witness-own-data-helper.mjs";

const yes = { declared: true, arrayIndex: false, ambiguous: false };
const no = { declared: false, arrayIndex: false, ambiguous: false };
const leaf = { type: "boolean" };
const object = { type: "object", properties: { enabled: leaf } };
const support = (schema, path, value = true, candidate = { enabled: true }, previous = {}) =>
  schemaWriteSupport(schema, path, value, candidate, previous);

test("frozen helper provenance survives the explicit guard-format correction; admission delegates", async () => {
  const corrected = await readFile(new URL("../src/schema-write-support.ts", import.meta.url), "utf8");
  const moved = reverseSafety(corrected);
  const guard = "    object\n  )\n    return { ...unsupported, ambiguous: true };\n";
  assert.ok(moved.includes(guard));
  const direct = moved.slice(moved.indexOf("function directSupport("), moved.indexOf("function traverseMembers(")).trimEnd();
  assert.equal(direct.split("\n").length, 49);
  // Restore only the documented braced guard to compare against the ORIGINAL frozen bytes.
  const original = moved.replace('import { z } from "zod";\n', "")
    .replace(/\nexport const structuralSupportSchema = z\.object\(\{[\s\S]*?satisfies z\.ZodType<StructuralSupport>;\n/, "")
    .replace(guard, "    object\n  ) {\n    return { ...unsupported, ambiguous: true };\n  }\n");
  // Frozen .11 tip 7bd29dd: original complete 234-line helper, not a copied validator fixture.
  assert.equal(createHash("sha256").update(original).digest("hex"),
    "c9402d5735c58a5e18bdafe7b28c9e55de7c2c553285e36eb0f44e8311e0158e");
  const delegate = await readFile(new URL("../../weaver-server/src/core/schema-write-support.ts", import.meta.url), "utf8");
  assert.equal(delegate, 'export {\n  type StructuralSupport,\n  schemaWriteSupport,\n} from "@weaver-conf/config-registry";\n');
  const admission = await readFile(new URL("../../weaver-server/src/core/config-write-admission.ts", import.meta.url), "utf8");
  assert.match(admission, /import \{ schemaWriteSupport \} from "\.\/schema-write-support";/);
});

test("literal safety provenance rejects original semantic changes, missing, duplicate and mismatched anchors", async () => {
  const corrected = await readFile(new URL("../src/schema-write-support.ts", import.meta.url), "utf8");
  const reconstructDigest = source => {
    const restored = reverseSafety(source);
    const guard = "    object\n  )\n    return { ...unsupported, ambiguous: true };\n";
    const original = restored.replace('import { z } from "zod";\n', "")
      .replace(/\nexport const structuralSupportSchema = z\.object\(\{[\s\S]*?satisfies z\.ZodType<StructuralSupport>;\n/, "")
      .replace(guard, "    object\n  ) {\n    return { ...unsupported, ambiguous: true };\n  }\n");
    return createHash("sha256").update(original).digest("hex");
  };
  const expected = "c9402d5735c58a5e18bdafe7b28c9e55de7c2c553285e36eb0f44e8311e0158e";
  assert.equal(reconstructDigest(corrected), expected);
  assert.notEqual(reconstructDigest(corrected.replace("if (members.length > 0)", "if (members.length > 1)")), expected);
  assert.notEqual(reconstructDigest(corrected.replace("one.length === 1", "one.length === 2")), expected);
  for (const { after } of safetyLedger) {
    assert.throws(() => reverseSafety(corrected.replace(after, "")), /count|missing/);
    assert.throws(() => reverseSafety(corrected.replace(after, after + after)), /count/);
  }
  assert.throws(() => reverseSafety(corrected.replace('ownField(schema, "items")', "schema.items")), /count/);
  assert.throws(() => reverseSafety(corrected.replace("function child(", "function notChild(")), /anchor count/);
  const direct = corrected.slice(corrected.indexOf("function directSupport("), corrected.indexOf("function traverseMembers(")).trimEnd();
  assert.equal(direct.split("\n").length, 49);
});

test("object declarations, patterns, schema wildcard and recursive payload trees", () => {
  assert.deepEqual(support(object, ["enabled"]), yes);
  assert.deepEqual(support(object, ["unknown"]), no);
  assert.deepEqual(support({ type: "object", patternProperties: { "^x": leaf } }, ["xyz"]), yes);
  assert.deepEqual(support({ type: "object", patternProperties: { "[": leaf } }, ["xyz"]), no);
  assert.deepEqual(support({ type: "object", additionalProperties: leaf }, ["wild"]), yes);
  assert.deepEqual(support({ type: "object", additionalProperties: true }, ["wild"]), no);
  const nested = { type: "object", properties: { child: object } };
  assert.deepEqual(support(nested, [], { child: { enabled: true } }, { child: { enabled: true } }), yes);
  assert.deepEqual(support(nested, [], { child: { unknown: true } }, { child: { unknown: true } }), no);
});

test("array index bounds, tuples, numeric object declarations and union ambiguity", () => {
  const array = { type: "array", items: leaf };
  assert.deepEqual(support(array, ["0"], true, [true], []), { ...yes, arrayIndex: true });
  for (const key of ["01", "-1", "4294967295", "9007199254740992", "name"]) {
    assert.equal(support(array, [key], true, [], []).declared, false);
  }
  assert.equal(support({ type: "array", items: [leaf] }, ["1"], true, [], []).declared, false);
  const union = { type: ["object", "array"], properties: { "0": leaf }, items: leaf };
  assert.deepEqual(support(union, ["0"], true, {}, null), { ...no, ambiguous: true });
  assert.deepEqual(support(union, ["0"], true, { "0": true }, {}), yes);
  assert.deepEqual(support(union, ["0"], true, [true], []), { ...yes, arrayIndex: true });
});

test("allOf witnesses and real candidate-conditioned anyOf/oneOf branches", () => {
  const branch = { ...object, required: ["enabled"] };
  const other = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
  assert.deepEqual(support({ allOf: [object, object] }, ["enabled"]), yes);
  for (const keyword of ["anyOf", "oneOf"]) {
    const schema = { [keyword]: [branch, other] };
    assert.deepEqual(support(schema, ["enabled"]), yes);
    assert.equal(validateEffectiveConfiguration(schema, { enabled: "bad" }).valid, false);
    assert.deepEqual(support(schema, ["enabled"], "bad", { enabled: "bad" }), no);
    assert.deepEqual(support(schema, ["enabled"], true, { name: "ok" }), no);
  }
  assert.deepEqual(support({ oneOf: [branch, branch] }, ["enabled"]), no);
  assert.deepEqual(support({ anyOf: [branch, branch] }, ["enabled"]), yes);
});

test("cycle guard terminates and support is a declaration witness, not a second validator", () => {
  const cyclic = { allOf: [] };
  cyclic.allOf.push(cyclic);
  assert.deepEqual(support(cyclic, ["enabled"]), no);
  const recursive = { type: "object", properties: {} };
  recursive.properties.self = recursive;
  assert.deepEqual(support(recursive, ["self", "self"]), no);
  assert.deepEqual(support(object, ["enabled"], "bad", { enabled: "bad" }), yes);
  assert.equal(validateEffectiveConfiguration(object, { enabled: "bad" }).valid, false);
  assert.deepEqual(structuralSupportSchema.parse(yes), yes);
  assert.equal(structuralSupportSchema.safeParse({ ...yes, declared: "yes" }).success, false);
});
