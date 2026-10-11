import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateChangePolicy } from "../../dist/browser.js";

test("trusted policy context requires emergency and a stored reason, never legacy modes or promotion bypass", () => {
  const context = { userId: "verified", roles: ["editor"] };
  const emergency = { ...context, trustedSession: { id: "verified", emergency: true, reason: "incident" } };
  const schema = { type: "number", "x-weaver": { changePolicy: "emergency-override" } };
  for (const denied of [context, { ...context, sessionMode: "emergency-override", overrideReason: "incident" },
    { ...emergency, trustedSession: { ...emergency.trustedSession, emergency: false } },
    { ...emergency, trustedSession: { ...emergency.trustedSession, reason: "  " } }])
    assert.equal(evaluateChangePolicy(schema, denied, "incident", () => true).outcome, "requires-emergency-auth");
  assert.equal(evaluateChangePolicy(schema, emergency, "incident", () => true).outcome, "allowed");
  assert.equal(evaluateChangePolicy(schema, emergency, "incident", () => false).outcome, "denied");
  for (const changePolicy of ["full-pipeline", "staging-gate"])
    assert.equal(evaluateChangePolicy({ type: "number", "x-weaver": { changePolicy } }, emergency, "incident", () => true).outcome, "requires-promotion");
});
