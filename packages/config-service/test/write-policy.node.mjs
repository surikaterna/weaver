import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createCanonicalSchemaRegistry } from "@weaver-conf/config-registry";
import { WritableMemory, writable, writableOptions } from "./fixtures/writable-memory.mjs";
import { authConfig, principal } from "./fixtures/authority.mjs";
import { deferred, registration } from "./fixtures/memory.mjs";

for (const metadata of [{ writeRestriction: ["other"] }, { changePolicy: "staging-gate" }, { changePolicy: "full-pipeline" }, { changePolicy: "emergency-override" }, { sensitive: true }, { visibility: "internal" }]) {
  for (const ancestor of [true, false]) {
    test(`policy ${JSON.stringify(metadata)} on ${ancestor ? "ancestor" : "leaf"} never dispatches`, async () => {
      const provider = new WritableMemory(), input = writableOptions([provider]);
      const leaf = { type: "string", ...(!ancestor ? { "x-weaver": metadata } : {}) };
      input.schemas = [registration("east", "alpha", { type: "object", properties: { flag: leaf }, ...(ancestor ? { "x-weaver": metadata } : {}) })];
      const { root } = await writable({ provider, input });
      try {
        const revision = root.revision, result = await root.set("/alpha/flag", "after", { layer: "base" });
        assert.equal(result.success, false); assert.equal(provider.writes, 0); assert.equal(root.revision, revision);
      } finally { await root.dispose(); }
    });
  }
}
test("invalid options/getters, unsupported values/targets, missing declarations and wrong CAS have zero effects", async () => {
  const { root, provider } = await writable(); let getters = 0;
  try {
    for (const options of [{ layer: "base", actor: "admin" }, { layer: "base", environment: "west" }, { layer: "base", roles: ["reader"] }, { layer: "base", sessionMode: "emergency-override" }, { layer: "base", viewId: "view" }, { layer: "base", scopePath: [] }, { get layer() { getters++; return "base"; } }])
      assert.equal((await root.set("/alpha/flag", "after", options)).success, false);
    for (const value of [{}, [], undefined, NaN, Infinity, () => {}, 1n]) assert.equal((await root.set("/alpha/flag", value, { layer: "base" })).success, false);
    for (const path of ["/alpha/cfg", "/alpha/list/0", "/alpha/instances/x/flag", "/alpha/unknown"]) assert.equal((await root.remove(path, { layer: "base" })).success, false);
    assert.equal((await root.set("/alpha/flag", "after", { layer: "base", ifRevision: "other-incarnation" })).error.code, "REVISION_CONFLICT");
    assert.equal(getters, 0); assert.equal(provider.writes + provider.removes, 0);
  } finally { await root.dispose(); }
});
test("dynamic layer-role fallback remains host configured, not an invented allow-all", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]), auth = authConfig(input);
  auth.layerWritePolicies = []; auth.dynamicScopeRoles = new Set(["reader"]);
  const { root } = await writable({ provider, input, host: { authConfig: auth } });
  try { assert.equal((await root.set("/alpha/flag", "after", { layer: "base" })).success, true); }
  finally { await root.dispose(); }
});
for (const phase of ["authorize", "audit"]) {
  test(`revocation during awaited ${phase} denies before dispatch`, async () => {
    const entered = deferred(), finish = deferred(); let setup;
    const callback = async () => { entered.resolve(); await finish.promise; return "allowed"; };
    const host = phase === "authorize" ? { hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: callback } }
      : { audit: async (record) => { if (record.phase === "before-dispatch") await callback(); } };
    setup = await writable({ host });
    try {
      const pending = setup.root.set("/alpha/flag", "after", { layer: "base" });
      await entered.promise; setup.controller.revoke(setup.token); finish.resolve();
      assert.equal((await pending).error.code, "FORBIDDEN"); assert.equal(setup.provider.writes, 0);
    } finally { finish.resolve(); await setup.root.dispose(); }
  });
}
test("invocation captures token/principal/options before a later root rebind", async () => {
  const entered = deferred(), finish = deferred(), seen = [];
  const setup = await writable({ host: { hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite(snapshot) {
    seen.push(snapshot.principalId); if (seen.length === 1) { entered.resolve(); await finish.promise; } return "allowed";
  } } } });
  try {
    const first = setup.root.set("/alpha/flag", "first", { layer: "base" }); await entered.promise;
    const options = { layer: "base" }, second = setup.root.set("/alpha/flag", "second", options); options.layer = "evil";
    setup.controller.bindRoot(setup.controller.mint(principal(setup.input, { principalId: "replacement" })));
    finish.resolve(); assert.equal((await first).success, true); assert.equal((await second).success, true);
    assert.deepEqual(seen, ["host-verified", "host-verified"]); assert.equal(setup.root.get("/alpha/flag"), "second");
  } finally { finish.resolve(); await setup.root.dispose(); }
});
test("expiration during real async authorization is rechecked before effects", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  const claims = principal(input, { expiresAt: Date.now() + 150 });
  const setup = await writable({ provider, input, claims, host: { hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite() { await sleep(175); return "allowed"; } } } });
  try { assert.equal((await setup.root.set("/alpha/flag", "after", { layer: "base" })).error.code, "FORBIDDEN"); assert.equal(provider.writes, 0); }
  finally { await setup.root.dispose(); }
});
test("canonical registry drift during authorization denies before effects", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "east" });
  for (const item of input.schemas) assert.equal(registry.register(item).success, true);
  input.schemas = [];
  const setup = await writable({ provider, input, host: { registry, hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite() {
    registry.register(registration("east", "new-owner")); return "allowed";
  } } } });
  try { assert.equal((await setup.root.set("/alpha/flag", "after", { layer: "base" })).success, false); assert.equal(provider.writes, 0); }
  finally { await setup.root.dispose(); }
});

test("grants cannot be combined or widened by caller mutation, replacement or foreign tokens", async () => {
  const setup = await writable(), foreign = await writable();
  try {
    assert.throws(() => setup.controller.bindRoot(foreign.token), { code: "FORBIDDEN" });
    assert.throws(() => setup.controller.forIdentity({}, setup.input.identity, "/alpha"), { code: "FORBIDDEN" });
    const original = principal(setup.input), grant = original.grants[0];
    const split = { ...original, grants: [{ ...grant, operations: ["write"], layers: [] }, { ...grant, operations: ["read", "inspect"] }] };
    const token = setup.controller.mint(split); setup.controller.bindRoot(token);
    split.grants[0].layers.push("base");
    assert.equal((await setup.root.set("/alpha/flag", "no", { layer: "base" })).error.code, "FORBIDDEN");
    const port = setup.controller.forIdentity(setup.token, setup.input.identity, "/alpha");
    const next = setup.controller.replace(setup.token, original);
    setup.controller.bindRoot(next);
    assert.equal((await port.set("/alpha/flag", "no", { layer: "base" })).error.code, "FORBIDDEN");
    const wrong = setup.controller.mint({ ...original, grants: [{ ...grant, namespace: "/alpha-other" }] });
    setup.controller.bindRoot(wrong);
    assert.equal((await setup.root.set("/alpha/flag", "no", { layer: "base" })).error.code, "FORBIDDEN");
    assert.equal(setup.provider.writes, 0);
  } finally { await setup.root.dispose(); await foreign.root.dispose(); }
});
test("raw hidden siblings validate without public projection leaks; tainted references cannot be overwritten", async () => {
  const provider = new WritableMemory("disk", "base", { alpha: { flag: "before", hidden: { a: "PRIVATE-INVALID" } } });
  const setup = await writable({ provider });
  try {
    const result = await setup.root.set("/alpha/flag", "after", { layer: "base" });
    assert.equal(result.error.code, "VALIDATION_ERROR"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); assert.equal(provider.writes, 0);
  } finally { await setup.root.dispose(); }
  provider.entries = { alpha: { flag: "before", hidden: { a: 1 }, secret: { _weaver: "secret-ref", key: "PRIVATE" }, alias: { _weaver: "mount", source: "alpha.hidden" } } };
  const input = writableOptions([provider]);
  for (const item of input.schemas.filter((item) => item.serviceId === "alpha")) {
    item.schema.properties.secret.additionalProperties = true;
    item.schema.properties.alias.additionalProperties = true;
  }
  const other = await writable({ provider, input });
  try {
    for (const path of ["/alpha/secret/key", "/alpha/alias/a", "/alpha/hidden/a"])
      assert.equal((await other.root.set(path, path.endsWith("key") ? "after" : 2, { layer: "base" })).error.code, "FORBIDDEN");
    assert.equal(provider.writes, 0);
    assert.equal((await other.root.set("/alpha/flag", "public", { layer: "base" })).success, true);
    assert.equal(other.root.get("/alpha/flag"), "public");
  } finally { await other.root.dispose(); }
});
test("rank drift and thrown/malformed authorization fail closed", async () => {
  for (const decision of [() => { throw Error("PRIVATE"); }, () => ({ allowed: true }), () => false]) {
    const setup = await writable({ host: { hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: decision } } });
    try { const result = await setup.root.set("/alpha/flag", "after", { layer: "base" }); assert.equal(result.error.code, "FORBIDDEN"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); assert.equal(setup.provider.writes, 0); }
    finally { await setup.root.dispose(); }
  }
  const provider = new WritableMemory(), input = writableOptions([provider]), config = authConfig(input);
  let drift = false; config.weaverConfig = { ...config.weaverConfig, getRank: () => drift ? 9 : 0 };
  const setup = await writable({ provider, input, host: { authConfig: config, audit: (record) => { if (record.phase === "before-dispatch") drift = true; } } });
  try { assert.equal((await setup.root.set("/alpha/flag", "after", { layer: "base" })).success, false); assert.equal(provider.writes, 0); }
  finally { await setup.root.dispose(); }
});
test("synchronous hook reentry cannot enqueue a nested mutation or deadlock the FIFO", async () => {
  let setup, nested;
  setup = await writable({ host: { hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite() {
    nested = await setup.root.set("/alpha/flag", "nested", { layer: "base" }); return "allowed";
  } } } });
  try {
    assert.equal((await setup.root.set("/alpha/flag", "outer", { layer: "base" })).success, true);
    assert.equal(nested.error.code, "FORBIDDEN"); assert.equal(setup.provider.writes, 1); assert.equal(setup.root.get("/alpha/flag"), "outer");
  } finally { await setup.root.dispose(); }
});
test("queued revoked operations never authorize or dispatch and do not poison later work", async () => {
  const entered = deferred(), finish = deferred(); let authorizations = 0;
  const setup = await writable({ host: { hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite() {
    authorizations++; if (authorizations === 1) { entered.resolve(); await finish.promise; } return "allowed";
  } } } });
  try {
    const first = setup.root.set("/alpha/flag", "first", { layer: "base" }); await entered.promise;
    const second = setup.root.set("/alpha/flag", "second", { layer: "base" });
    setup.controller.revoke(setup.token); finish.resolve();
    assert.equal((await first).error.code, "FORBIDDEN"); assert.equal((await second).error.code, "FORBIDDEN");
    assert.equal(authorizations, 1); assert.equal(setup.provider.writes, 0);
    setup.controller.bindRoot(setup.controller.mint(principal(setup.input)));
    assert.equal((await setup.root.set("/alpha/flag", "third", { layer: "base" })).success, true);
  } finally { finish.resolve(); await setup.root.dispose(); }
});
test("registry drift after dispatch fences access but preserves a known committed result", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "east" });
  for (const item of input.schemas) assert.equal(registry.register(item).success, true);
  input.schemas = []; const original = provider.write;
  provider.write = async function (key, value) { const result = await original.call(this, key, value); registry.register(registration("east", "new-owner")); return result; };
  const setup = await writable({ provider, input, host: { registry } });
  try {
    const result = await setup.root.set("/alpha/flag", "committed", { layer: "base" });
    assert.equal(result.success, true); assert.equal(provider.entries.alpha.flag, "committed");
    assert.throws(() => setup.root.get("/alpha/flag"), { code: "FORBIDDEN" });
    assert.equal((await setup.root.set("/alpha/flag", "never", { layer: "base" })).error.code, "WRITE_UNAVAILABLE");
    assert.equal(provider.writes, 1);
  } finally { await setup.root.dispose(); }
});
test("public overrides cannot hide destructive raw atomic ancestor replacement", async () => {
  for (const atomic of [null, [1, 2], "atomic"]) {
    const base = new WritableMemory("disk", "base", { alpha: { cfg: atomic } });
    const overlay = new WritableMemory("overlay", "overlay", { alpha: { cfg: { a: 99 } } });
    const input = writableOptions([base, overlay]);
    const setup = await writable({ provider: base, input });
    try {
      assert.equal(setup.root.get("/alpha/cfg/a"), 99);
      const revision = setup.root.revision;
      assert.equal((await setup.root.set("/alpha/cfg/a", 2, { layer: "base" })).error.code, "UNSUPPORTED_OPERATION");
      assert.equal(base.writes, 0); assert.deepEqual(base.entries.alpha.cfg, atomic); assert.equal(setup.root.revision, revision);
    } finally { await setup.root.dispose(); }
  }
});
test("session-bearing principals and explicitly configured session layers cannot enable writes", async () => {
  for (const principalSession of [true, false]) {
    const provider = new WritableMemory(), input = writableOptions([provider]), config = authConfig(input);
    const claims = principal(input);
    if (principalSession) claims.session = { mode: "emergency-override", overrideReason: "host reason" };
    else config.sessionLayer = "base";
    const setup = await writable({ provider, input, claims, host: { authConfig: config } });
    try {
      assert.equal((await setup.root.set("/alpha/flag", "never", { layer: "base" })).error.code, "POLICY_VIOLATION");
      assert.equal(provider.writes, 0);
    } finally { await setup.root.dispose(); }
  }
});
