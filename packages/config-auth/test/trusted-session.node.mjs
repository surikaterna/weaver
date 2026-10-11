import assert from "node:assert/strict";
import { test } from "node:test";
import { withAuth } from "../dist/index.js";
import { configurationAccessContextSchema, defineWeaver, Layers } from "@weaver-conf/config-types";

const auth = withAuth({ weaverConfig: defineWeaver([Layers.Static("custom"), Layers.Static("scope"), Layers.Ephemeral("incident")]),
  sessionLayer: "incident", visibilityRoles: { admin: new Set(), platform: new Set() },
  layerWritePolicies: [{ layer: "incident", allowedRoles: ["editor"] }], dynamicScopeRoles: new Set(["editor"]) });
const context = { userId: "verified", roles: ["editor"] };
const emergency = { ...context, trustedSession: { id: "verified-session", emergency: true, reason: "incident" } };
const schema = (metadata) => ({ type: "number", "x-weaver": metadata });

test("known rank validation precedes trusted emergency and configured slots retain role checks", () => {
  assert.equal(auth.canWrite(context, "scope", "x", schema({ maxOverrideLayer: "scope" })), true);
  assert.equal(auth.canWrite(context, "incident", "x", schema({ maxOverrideLayer: "custom" })), false);
  assert.equal(auth.canWrite(emergency, "incident", "x", schema({ maxOverrideLayer: "custom" })), true);
  assert.equal(auth.canWrite(emergency, "scope", "x", schema({ maxOverrideLayer: "custom" })), false);
  assert.equal(auth.canWrite(emergency, "unknown", "x", undefined), false);
  assert.equal(auth.canWrite(emergency, "incident", "x", schema({ maxOverrideLayer: "unknown" })), false);
  assert.equal(auth.canWrite({ ...emergency, roles: [] }, "incident", "x", schema({ maxOverrideLayer: "custom" })), false);
});

test("one native trusted context replaces mode aliases without bypassing blocked/writeRestriction/read policy", () => {
  assert.equal(configurationAccessContextSchema.safeParse(emergency).success, true);
  assert.equal(configurationAccessContextSchema.safeParse({ ...context, sessionMode: "god-mode" }).success, false);
  assert.equal(auth.canWrite({ ...context, sessionMode: "god-mode" }, "incident", "x", schema({ sessionMode: "restricted" })), false);
  assert.equal(auth.canWrite(emergency, "incident", "x", schema({ sessionMode: "restricted" })), true);
  assert.equal(auth.canWrite(emergency, "incident", "x", schema({ sessionMode: "blocked" })), false);
  assert.equal(auth.canWrite(emergency, "incident", "x", schema({ writeRestriction: ["other"] })), false);
  assert.equal(auth.canRead(emergency, "x", schema({ visibility: "internal" })), false);
});
