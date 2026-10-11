import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import * as persistence from "../dist/persistence.js";
import { createRegistryAdapter } from "../dist/internal/server-adapter.js";
import { service } from "./fixtures/requests.mjs";
import { exercisePersistenceBoundary } from "./operation-support-fixture.mjs";

test("public ESM/CJS graph boundaries reject all own accessors without losing valid graphs", () => {
  const require = createRequire(import.meta.url);
  for (const codec of [persistence, require("../dist/persistence.cjs")])
    assert.deepEqual(exercisePersistenceBoundary(codec), { accessorCases: 16, getters: 0, calls: 0 });
});

test("ESM/CJS persistence share v1/v2 tuple codec, schema aliases and deterministic ordering", () => {
  const require = createRequire(import.meta.url);
  for (const codec of [persistence, require("../dist/persistence.cjs")]) {
    const adapter = createRegistryAdapter({ defaultEnvironment: "dev" });
    const request = service("prod/dev:x");
    const shared = { type: "string", title: "leaf", examples: ["value"] };
    request.schema = { type: "object", properties: { z: shared, a: shared }, additionalProperties: shared };
    const prepared = adapter.prepare(request); assert.equal(prepared.result.success, true); prepared.publish();
    const encoded = codec.serializeRegistry(adapter.snapshot());
    assert.equal(codec.serializedSchemaRegistrySchema.safeParse(encoded).success, true);
    for (const raw of [encoded, { environments: encoded.environments }]) {
      const decoded = codec.parsePersistedRegistry(raw);
      const schema = [...decoded.schemas.values()][0].schema;
      assert.equal(schema.properties.z, schema.properties.a);
      assert.equal(schema.properties.z, schema.additionalProperties);
      assert.equal(JSON.stringify(codec.serializeRegistry(decoded)), JSON.stringify(encoded));
    }
  }
});

test("public parsing errors are static and typed; initial descriptor hazards never execute", () => {
  let gets = 0;
  const bad = { get environments() { gets++; throw Error("SECRET"); } };
  for (const input of [bad, null, {}, { version: 99, environments: {} }, { environments: { SECRET: {} } }])
    assert.throws(() => persistence.parsePersistedRegistry(input), (error) => {
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.equal(error.message, "Invalid registry persistence data");
      assert.equal(error.cause, undefined); assert.equal(error.issues, undefined);
      assert.doesNotMatch(JSON.stringify(error), /SECRET/); return true;
    });
  assert.equal(gets, 0);
  assert.equal(persistence.parsePersistedRegistry(undefined).schemas.size, 0);
  assert.throws(() => persistence.decodeSchemaGraph({ encoding: "SECRET" }), { code: "VALIDATION_ERROR" });
});
