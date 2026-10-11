import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateEffectiveConfiguration } from "@weaver-conf/config-engine";
import { schemaWriteSupport, structuralSupportSchema } from "../dist/index.js";

const yes = { declared: true, arrayIndex: false, ambiguous: false };
const no = { declared: false, arrayIndex: false, ambiguous: false };
const leaf = { type: "boolean" };
const object = { type: "object", properties: { enabled: leaf } };
const support = (schema, path, value = true, candidate = { enabled: true }, previous = {}) =>
  schemaWriteSupport(schema, path, value, candidate, previous);

test("server admission delegates to the sole registry witness implementation", async () => {
  const delegate = await readFile(new URL("../../weaver-server/src/core/schema-write-support.ts", import.meta.url), "utf8");
  assert.equal(delegate, 'export {\n  type StructuralSupport,\n  schemaWriteSupport,\n} from "@weaver-conf/config-registry";\n');
  const admission = await readFile(new URL("../../weaver-server/src/core/config-write-admission.ts", import.meta.url), "utf8");
  const ts = await import("typescript");
  const parse = (text) => ts.createSourceFile("admission.ts", text, ts.ScriptTarget.Latest, true);
  const server = parse(admission);
  assert.equal(server.statements.length, 2);
  const exports = server.statements.flatMap((node) => {
    assert.ok(ts.isExportDeclaration(node) && ts.isNamedExports(node.exportClause));
    assert.equal(node.moduleSpecifier.text, "@weaver-conf/config-service/admission");
    return node.exportClause.elements.map((item) => `${node.isTypeOnly || item.isTypeOnly ? "type" : "value"}:${item.name.text}`);
  });
  assert.deepEqual(exports, ["type:AdmissionContext", "type:Mutation", "value:prepareConfigMutation"]);
  const entry = parse(await readFile(new URL("../../config-service/src/admission.ts", import.meta.url), "utf8"));
  assert.ok(entry.statements.some((node) => ts.isExportDeclaration(node) && !node.isTypeOnly &&
    node.moduleSpecifier.text === "./authority/schema-admission" && ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.some((item) => !item.isTypeOnly && item.name.text === "prepareConfigMutation")));
  const shared = parse(await readFile(new URL("../../config-service/src/authority/schema-admission.ts", import.meta.url), "utf8"));
  const witness = shared.statements.find((node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text === "@weaver-conf/config-registry");
  assert.ok(witness && !witness.importClause.isTypeOnly && ts.isNamedImports(witness.importClause.namedBindings));
  assert.ok(witness.importClause.namedBindings.elements.some((item) => !item.isTypeOnly &&
    item.name.text === "schemaWriteSupport" && (item.propertyName?.text ?? item.name.text) === "schemaWriteSupport"));
  const callers = [];
  for (const fn of shared.statements.filter(ts.isFunctionDeclaration)) {
    let calls = 0;
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
        assert.notEqual(node.name?.text, "schemaWriteSupport", "canonical witness must not be shadowed or duplicated");
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "schemaWriteSupport") calls++;
      ts.forEachChild(node, visit);
    };
    visit(fn);
    if (calls) callers.push([fn.name.text, calls]);
  }
  assert.deepEqual(callers, [["errorForSupport", 2], ["rejectExistingArrayIndices", 1]]);
});

test("object declarations, patterns, schema wildcard and recursive payload trees", () => {
  assert.deepEqual(support(object, ["enabled"]), yes);
  assert.deepEqual(support(object, ["unknown"]), no);
  assert.deepEqual(support({ type: "object", patternProperties: { "^x": leaf } }, ["xyz"]), yes);
  assert.deepEqual(support({ type: "object", patternProperties: { "[": leaf } }, ["xyz"]), no);
  assert.deepEqual(support({ type: "object", additionalProperties: leaf }, ["wild"]), yes);
  assert.deepEqual(support({ type: "object", additionalProperties: true }, ["wild"]), yes);
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
