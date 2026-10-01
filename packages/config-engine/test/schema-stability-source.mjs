import assert from "node:assert/strict";
import { captureSchemaStability, schemaStabilityMatches } from "../src/schema-validation-schema-stability.ts";

const shared = { type: "number", default: 1, const: 1, enum: [1] };
const schema = { type: "object", properties: { a: shared, b: shared } };
const initial = captureSchemaStability(schema);
assert.equal(initial.reusable, true);
assert.equal(initial.objects.some(({ target }) => target === shared), true);
for (const mutate of [
  () => { shared.default = 2; },
  () => { shared.const = 2; },
  () => { shared.enum[0] = 2; },
  () => { schema.properties.a = { type: "string" }; },
  () => { Object.defineProperty(shared, "type", { enumerable: false }); },
  () => { Object.setPrototypeOf(shared, null); },
  () => { Object.preventExtensions(shared); },
]) {
  const before = captureSchemaStability(schema);
  assert.equal(before.reusable, true);
  mutate();
  assert.equal(schemaStabilityMatches(before), false);
  assert.equal(schemaStabilityMatches(captureSchemaStability(schema)), true);
}
let getters = 0;
const executable = { type: "number" };
const before = captureSchemaStability(executable);
Object.defineProperty(executable, "default", { get() { getters++; return 1; } });
assert.equal(schemaStabilityMatches(before), false);
assert.equal(captureSchemaStability(executable).reusable, false);
assert.equal(getters, 0, "descriptor inspection disables caching, not trusted schema execution");
