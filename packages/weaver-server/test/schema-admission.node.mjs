import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareRegisteredObjectWrite, prepareRegisteredPatchWrite, validateRegisteredEffectiveConfiguration } from "../src/core/config-service-schema-writes.ts";
import { plainPatchSchema, preparationContext } from "./core/schema-write-pipeline-fixtures.mjs";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { createSchemaRegistry } from "../src/core/schema-registry.ts";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";

const schemaError = {
  code: "invalid-schema", path: "$.billing", segments: ["billing"],
  message: "Schema must contain only acyclic own plain data",
};
function assertWriteFailure(result, path) {
  assert.equal(result.success, false);
  assert.deepEqual(result.result.error, {
    code: "VALIDATION_ERROR", message: "Configuration does not match registered schema",
    details: { path, anchorPath: "/billing", environment: "test", errors: [schemaError] },
  });
}

test("object, patch and effective boundaries reject own schema slots and graph hazards before reads", async () => {
  let getters = 0, reads = 0;
  const accessor = {}; Object.defineProperty(accessor, "hidden", { get() { getters++; return "private"; } });
  const cycle = {}; cycle.self = cycle;
  const hazards = [
    { ...plainPatchSchema(), example: accessor },
    { ...plainPatchSchema(), example: cycle },
    { ...plainPatchSchema(), example: new Date() },
    { ...plainPatchSchema(), example: Symbol("private") },
    { ...plainPatchSchema(), example: () => true },
    { ...plainPatchSchema(), example: 1n },
    { ...plainPatchSchema(), [Symbol("private")]: true },
    new Proxy(plainPatchSchema(), { ownKeys() { throw Error("private reflection message"); } }),
  ];
  for (const schema of hazards) {
    const { options } = preparationContext(schema);
    assertWriteFailure(await prepareRegisteredObjectWrite("/billing", { value: 1 }, options, "test"), "/billing");
    assertWriteFailure(await prepareRegisteredPatchWrite("/billing/value", 1, options, "test", async () => { reads++; }), "/billing/value");
    assert.deepEqual(await validateRegisteredEffectiveConfiguration("/billing", options, "test", async () => { reads++; }), { valid: false, errors: [schemaError] });
  }
  const { anchor, options } = preparationContext(plainPatchSchema());
  Object.defineProperty(anchor, "schema", { get() { getters++; return plainPatchSchema(); } });
  assertWriteFailure(await prepareRegisteredObjectWrite("/billing", { value: 1 }, options, "test"), "/billing");
  assertWriteFailure(await prepareRegisteredPatchWrite("/billing/value", 1, options, "test", async () => { reads++; }), "/billing/value");
  assert.deepEqual(await validateRegisteredEffectiveConfiguration("/billing", options, "test", async () => { reads++; }), { valid: false, errors: [schemaError] });
  assert.equal(getters, 0);
  assert.equal(reads, 0);
});

test("patch and effective recheck introduced hidden getters after exactly one awaited retrieval", async () => {
  for (const mode of ["patch", "effective"]) for (const returned of [undefined, { value: "old" }]) {
    const schema = plainPatchSchema();
    const { options } = preparationContext(schema);
    let reads = 0, getters = 0;
    const retrieve = async () => {
      reads++;
      await Promise.resolve();
      schema.example = { nested: {} };
      Object.defineProperty(schema.example.nested, "private", { get() { getters++; return "private"; } });
      return returned;
    };
    const result = mode === "patch"
      ? await prepareRegisteredPatchWrite("/billing/value", 1, options, "test", retrieve)
      : await validateRegisteredEffectiveConfiguration("/billing", options, "test", retrieve);
    if (mode === "patch") assertWriteFailure(result, "/billing/value");
    else assert.deepEqual(result, { valid: false, errors: [schemaError] });
    assert.equal(reads, 1);
    assert.equal(getters, 0);
    assert.equal(Object.isFrozen(schema), false);
  }
});

test("anchor error-path descriptors reject accessors before path checks or retrieval", async () => {
  const { anchor, options } = preparationContext(plainPatchSchema());
  let getters = 0, reads = 0;
  Object.defineProperty(anchor, "path", { get() { getters++; return "/billing"; } });
  const retrieve = async () => { reads++; return { value: "old" }; };
  assertWriteFailure(await prepareRegisteredObjectWrite("/billing", { value: 1 }, options, "test"), "/billing");
  const patch = await prepareRegisteredPatchWrite("/billing/value", 1, options, "test", retrieve);
  assert.equal(patch.success, false);
  assert.equal(patch.result.error.details.errors[0].code, "invalid-schema");
  assert.deepEqual(await validateRegisteredEffectiveConfiguration("/billing", options, "test", retrieve), { valid: false, errors: [schemaError] });
  assert.equal(getters, 0);
  assert.equal(reads, 0);
});

test("current schema-slot replacement cannot combine a stale session with a new patch schema", async () => {
  const original = plainPatchSchema();
  const { anchor, options } = preparationContext(original);
  let reads = 0;
  const result = await prepareRegisteredPatchWrite("/billing/value", 1, options, "test", async () => {
    reads++;
    anchor.schema = { ...plainPatchSchema(), maxProperties: 0 };
    return { value: "old" };
  });
  assert.equal(result.success, false);
  assert.equal(result.result.error.details.errors[0].code, "invalid-value");
  assert.equal(reads, 1);
  assert.notEqual(anchor.schema, original);
  const success = await prepareRegisteredPatchWrite("/billing/value", "new", options, "test", async () => {
    anchor.schema = plainPatchSchema();
    return { value: "old" };
  });
  assert.deepEqual(success, { success: true, key: "billing", value: { value: "new" } });
});

test("schema admission preserves null prototypes, shared acyclic data, identity and descriptors", async () => {
  const shared = Object.assign(Object.create(null), { type: "string" });
  const schema = Object.assign(Object.create(null), { type: "object", properties: { left: shared, right: shared } });
  const { anchor, options } = preparationContext(schema);
  const before = Object.getOwnPropertyDescriptors(shared);
  const result = await prepareRegisteredObjectWrite("/billing", { left: "a", right: "b" }, options, "test");
  assert.deepEqual(result, { success: true, key: "billing", value: { left: "a", right: "b" } });
  assert.equal(anchor.schema, schema);
  assert.equal(schema.properties.left, schema.properties.right);
  assert.deepEqual(Object.getOwnPropertyDescriptors(shared), before);
  assert.equal(Object.getPrototypeOf(schema), null);
  assert.equal(Object.isFrozen(schema), false);
  assert.equal(Object.isFrozen(shared), false);
});

test("real bound canonical registry owns registered writes despite borrower DTO mutation", async () => {
  const provider = createInMemoryStorageProvider({ id: "provider", layer: "platform", initialEntries: { billing: { value: "old" } } });
  const service = await createWeaverConfigService({ providers: [provider], environment: "test" });
  const registry = createSchemaRegistry({ configService: service });
  const registered = await registry.register({ serviceId: "billing", environment: "test", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema: plainPatchSchema() });
  assert.equal(registered.success, true);
  const borrowed = registry.getRegisteredSchema("/billing", "test");
  borrowed.schema.properties.value.type = "boolean";
  const result = await service.patchRegisteredPath("platform", "/billing/value", "new", { schemaRegistry: registry });
  assert.equal(result.success, true);
  assert.equal((await provider.load()).entries.billing.value, "new");
  const validation = await service.validateRegisteredEffective("/billing", { schemaRegistry: registry });
  assert.deepEqual(validation, { valid: true, errors: [] });
});
