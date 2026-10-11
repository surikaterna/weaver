import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionHost } from "./fixtures/session-host.mjs";
import { commands, WritableMemory, writableOptions, writer } from "./fixtures/writable-memory.mjs";
import { principal } from "./fixtures/authority.mjs";
import { registration, viewSchema } from "./fixtures/memory.mjs";

async function setup(host = {}) {
  const provider = new WritableMemory();
  const input = writableOptions([provider]);
  input.schemas[0].schema.properties.flag["x-weaver"] = { maxOverrideLayer: "base" };
  return sessionHost({ provider, input, host });
}
const write = (s, id, value) => s.mutations.apply(commands(s.input, { operation: "set", path: "/alpha/flag", layer: "incident", sessionId: id, value }));

test("only a root-owned active emergency source bypasses ceilings; expiry restores base", async () => {
  const s = await setup();
  try {
    const ordinary = (await s.activate()).value;
    const emergency = (await s.activate({ emergency: true })).value;
    assert.throws(() => s.controller.mint({ ...s.claims,
      trustedSession: { id: emergency.id, emergency: true, reason: "spoof" } }), { code: "VALIDATION_ERROR" });
    const injected = await s.mutations.apply(commands(s.input, { operation: "set", path: "/alpha/flag", value: "spoof", layer: "incident", sessionId: ordinary.id,
      trustedSession: { id: emergency.id, emergency: true, reason: "spoof" } }));
    assert.equal(injected.success, false);
    assert.equal((await write(s, ordinary.id, "ordinary")).error.code, "POLICY_VIOLATION");
    assert.equal((await write(s, emergency.id, "emergency")).success, true);
    assert.equal(s.reader.get(["flag"]), "emergency");
    assert.equal(s.provider.writes, 0);
    s.clock.time += 101;
    assert.equal((await write(s, emergency.id, "expired")).success, false);
    s.clock.fire(); await s.root.flush();
    assert.equal(s.reader.get(["flag"]), "before");
  } finally { await s.root.dispose(); }
});

test("emergency is per confined provider, not shared by other namespaces, view tiers or creator tokens", async () => {
  const provider = new WritableMemory("disk", "base", { alpha: { flag: "base", instances: { one: { flag: "one" }, two: { flag: "two" } } }, beta: { flag: "beta" } });
  const input = writableOptions([provider]);
  const schema = viewSchema(); schema.properties.flag["x-weaver"] = { maxOverrideLayer: "base" };
  schema.properties.instances.additionalProperties.properties.flag["x-weaver"] = { maxOverrideLayer: "base" };
  input.schemas = [registration("east", "alpha", schema), registration("east", "beta", { type: "object", properties: { flag: { type: "string", "x-weaver": { maxOverrideLayer: "base" } } } })];
  input.layers.push({ kind: "session", layer: "incident" });
  const claims = principal(input, { sessionPermissions: ["read", "activate", "deactivate", "emergency"] });
  claims.grants.push({ ...claims.grants[0], namespace: "/beta" }, { ...claims.grants[0], views: ["one", "two"] });
  const s = await sessionHost({ provider, input, claims });
  try {
    const base = (await s.activate({ emergency: true })).value;
    assert.equal((await write(s, base.id, "base emergency")).success, true);
    const beta = (await s.activate({ namespace: "/beta" })).value;
    const denied = await s.mutations.apply(commands(input, { namespace: "/beta", path: "/beta/flag", operation: "set", layer: "incident", sessionId: beta.id, value: "must not inherit" }));
    assert.equal(denied.error.code, "POLICY_VIOLATION");
    const foreignOwner = s.controller.mint(claims), sessions = s.controller.forSessions(foreignOwner);
    const one = s.reader.forView("one"), two = s.reader.forView("two");
    await one.prepare(); await two.prepare();
    const view = (await sessions.activate({ identity: input.identity, namespace: "/alpha", viewId: "one", reason: "view incident", emergency: true })).value;
    const command = commands(input, { viewId: "one", path: "/alpha/flag", operation: "set", layer: "incident", sessionId: view.id, value: "view emergency" });
    assert.equal((await s.mutations.apply(command)).success, false, "same principal name does not inherit another token's session");
    assert.equal((await s.controller.forMutations(foreignOwner).apply(command)).success, true);
    assert.equal(one.get(["flag"]), "view emergency"); assert.equal(two.get(["flag"]), "two");
    assert.equal(s.reader.get(["flag"]), "base emergency");
    s.controller.revoke(foreignOwner); await s.root.flush();
    assert.equal(one.get(["flag"]), "one"); assert.equal(s.reader.get(["flag"]), "base emergency");
    assert.equal(s.controller.forIdentity(s.token, { identity: input.identity, namespace: "/beta" }).get(["flag"]), "beta");
  } finally { await s.root.dispose(); }
});

for (const end of ["deadline", "revocation"]) test(`emergency ${end} during authorization denies every batch prefix before effects`, async () => {
  let s, armed = false;
  const host = { hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite(_principal, request) {
    if (armed && request.operation === "write" && request.sessionId) {
      armed = false;
      if (end === "deadline") s.clock.time += 101;
      else s.controller.revoke(s.token);
    }
    return "allowed";
  } } };
  s = await setup(host);
  try {
    const emergency = (await s.activate({ emergency: true })).value;
    armed = true;
    const result = await s.mutations.apply([
      ...commands(s.input, { operation: "set", path: "/alpha/cfg/a", value: 2 }),
      ...commands(s.input, { operation: "set", path: "/alpha/flag", value: "denied", layer: "incident", sessionId: emergency.id }),
    ]);
    assert.equal(result.success, false); assert.equal(result.outcome, "rejected");
    assert.equal(s.provider.writes, 0); assert.equal(s.provider.entries.alpha.cfg.a, 1);
  } finally { await s.root.dispose(); }
});

test("accepted blocked flush refreshes emergency eligibility before publishing a new generation", async () => {
  const provider = new WritableMemory();
  const input = writableOptions([provider]);
  input.schemas[0].schema.properties.flag["x-weaver"] = { maxOverrideLayer: "base" };
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  provider.flush = async () => { entered(); await new Promise((resolve) => { release = resolve; }); };
  const s = await sessionHost({ provider, input, host: { writers: [writer(provider, { flush: "required" })] } });
  try {
    const emergency = (await s.activate({ emergency: true })).value;
    assert.equal((await write(s, emergency.id, "emergency")).success, true);
    const observed = [];
    s.reader.onChange(["flag"], (event) => observed.push(event));
    const pending = s.mutations.apply(commands(input, { operation: "set", path: "/alpha/cfg/a", value: 2 }));
    await waiting;
    s.clock.time += 101;
    release();
    const result = await pending;
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(provider.entries.alpha.cfg.a, 2);
    assert.equal(s.reader.get(["flag"]), "before", "new generation cannot reuse preflight emergency exemption");
    s.clock.fire();
    await s.sessions.deactivate({ sessionId: emergency.id });
    assert.equal(s.reader.get(["flag"]), "before");
    assert.equal(observed.length, 1);
  } finally { release?.(); await s.root.dispose(); }
});
