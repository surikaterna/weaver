import assert from "node:assert/strict";
import test from "node:test";
import { assertUpgradeWrite } from "../src/core/upgrade-write-result.ts";

const sanitized = "Upgrade durable write failed";
const secret = "mongodb://secret@127.0.0.1/private.collection owner fence op-id";

test("upgrade write classification returns successful outcomes", () => {
  assert.doesNotThrow(() => assertUpgradeWrite({ success: true }, sanitized));
});

for (const [providerCode, expectedCode] of [
  ["COMMIT_OUTCOME_UNKNOWN", "COMMIT_OUTCOME_UNKNOWN"],
  ["REVISION_CONFLICT", "REVISION_CONFLICT"],
  ["PROVIDER_ERROR", "WRITE_ERROR"],
  [undefined, "WRITE_ERROR"],
]) {
  test(`upgrade write classification maps ${providerCode ?? "missing"} safely`, () => {
    const result = {
      success: false,
      ...(providerCode
        ? { error: { code: providerCode, message: secret, details: { secret } } }
        : {}),
    };
    assert.throws(
      () => assertUpgradeWrite(result, sanitized),
      (error) => {
        assert.equal(error.code, expectedCode);
        assert.equal(error.message, sanitized);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      },
    );
  });
}
