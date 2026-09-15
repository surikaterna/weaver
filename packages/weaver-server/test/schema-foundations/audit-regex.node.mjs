import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { registeredConfigurationSchemaSchema } from "@weaver-conf/config-types";
import { fixture, owner, registration, validateCanonicalSchema } from "./fixtures.mjs";

const wrap = (child) => ({ type: "object", properties: { unused: { type: "array", items: { type: "object", additionalProperties: child } } } });

for (const profile of ["memory", "fs-restart"]) {
  test(`R1 unsafe regex rejected throughout registration and hydration (${profile})`, async () => {
    const { registry, writes } = await fixture(undefined, profile);
    await registry.register(registration({ type: "object" }, [{ slotPath: "/plugins", accepts: "object" }]));
    const before = structuredClone(registry.listAll());
    const writesBefore = writes.length;
    for (const pattern of ["^(a+)+$", "a".repeat(201)]) {
      const invalid = [
        { type: "object", properties: { name: { type: "string", pattern } } },
        { type: "object", patternProperties: { [pattern]: { type: "integer" } } },
        wrap({ type: "string", pattern }),
        wrap({ type: "object", patternProperties: { [pattern]: { type: "integer" } } }),
      ];
      for (const schema of invalid) {
        assert.equal(registeredConfigurationSchemaSchema.safeParse(schema).success, false);
        for (const request of [registration(schema), { serviceId: "svc", environment: "dev", owner, providerId: "bad", slotPath: "/plugins", schema }]) {
          const result = await registry.register(request);
          assert.equal(result.success, false);
          assert.equal(result.error.code, "VALIDATION_ERROR");
          assert.match(result.error.message, /Unsafe regex/);
        }
        for (const kind of ["service", "fragment"]) {
          assert.throws(() => validateCanonicalSchema(schema, kind), { code: "VALIDATION_ERROR" });
        }
      }
    }
    assert.equal(writes.length, writesBefore);
    assert.deepEqual(registry.listAll(), before);
  });
}

test("R1 materializer refuses ReDoS before execution in a bounded child process", () => {
  const script = `import assert from 'node:assert/strict';
    import {materializeConfigurationDefaults} from '@weaver-conf/config-engine';
    const schema = {type:'object',patternProperties:{'^(a+)+$':{type:'object'}}};
    assert.throws(() => materializeConfigurationDefaults(schema, {['a'.repeat(40)+'!']: {}}), /Unsafe regex/);`;
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 5000, stdio: "pipe" }));
});
