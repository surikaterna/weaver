import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { schemaClaims } from "./fixtures/live-registry.mjs";
import { WritableMemory, writable, writableOptions, commands } from "./fixtures/writable-memory.mjs";
import { authConfig, principal } from "./fixtures/authority.mjs";
import { deferred, registration } from "./fixtures/memory.mjs";

for (const metadata of [{ writeRestriction: ["other"] }, { changePolicy: "staging-gate" }, { changePolicy: "full-pipeline" }, { changePolicy: "emergency-override" }, { sensitive: true }, { visibility: "internal" }]) {
  for (const ancestor of [true, false]) {
    test(`policy ${JSON.stringify(metadata)} on ${ancestor ? "ancestor" : "leaf"} never dispatches`, async () => {
      const provider = new WritableMemory(), input = writableOptions([provider]);
      const leaf = { type: "string", ...(!ancestor ? { "x-weaver": metadata } : {}) };
      input.schemas = [registration("east", "alpha", { type: "object", properties: { flag: leaf }, ...(ancestor ? { "x-weaver": metadata } : {}) })];
      const { root, reader, mutations } = await writable({ provider, input });
      try {
        const revision = reader.inspect(["flag"]).revision, result = await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "after" }));
        assert.equal(result.success, false); assert.equal(provider.writes, 0); assert.equal(reader.inspect(["flag"]).revision, revision);
      } finally { await root.dispose(); }
    });
  }
}
test("invalid options/getters, unsupported values/targets, missing declarations and wrong CAS have zero effects", async () => {
  const { root, provider, mutations, input } = await writable(); let getters = 0;
  try {
    for (const options of [{ layer: "base", actor: "admin" }, { layer: "base", environment: "west" }, { layer: "base", roles: ["reader"] }, { layer: "base", sessionMode: "emergency-override" }, { layer: "base", viewId: "view" }, { layer: "base", scopePath: [] }, { get layer() { getters++; return "base"; } }])
      assert.equal((await mutations.apply([Object.defineProperties({ identity: input.identity, namespace: "/alpha", operation: "set", path: "/alpha/flag", value: "after" }, Object.getOwnPropertyDescriptors(options))])).success, false);
    for (const value of [{}, [], undefined, NaN, Infinity, () => {}, 1n]) assert.equal((await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value }))).success, false);
    for (const path of ["/alpha/list/0", "/alpha/instances/x/flag", "/alpha/unknown"]) assert.equal((await mutations.apply(commands(input, { operation: "remove", path }))).success, false);
    assert.equal((await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "after", ifRevision: "other-incarnation" }))).error.code, "REVISION_CONFLICT");
    assert.equal(getters, 0); assert.equal(provider.writes + provider.removes, 0);
  } finally { await root.dispose(); }
});
test("dynamic layer-role fallback remains host configured, not an invented allow-all", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]), auth = authConfig(input);
  auth.layerWritePolicies = []; auth.dynamicScopeRoles = new Set(["reader"]);
  const { root, mutations } = await writable({ provider, input, host: { authConfig: auth } });
  try { assert.equal((await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "after" }))).success, true); }
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
      const pending = setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "after" }));
      await entered.promise; setup.controller.revoke(setup.token); finish.resolve();
      assert.equal((await pending).error.code, "FORBIDDEN"); assert.equal(setup.provider.writes, 0);
    } finally { finish.resolve(); await setup.root.dispose(); }
  });
}
test("invocation captures token/principal/options independently of a later issued reader", async () => {
  const entered = deferred(), finish = deferred(), seen = [];
  const setup = await writable({ host: { hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite(snapshot) {
    seen.push(snapshot.principalId); if (seen.length === 1) { entered.resolve(); await finish.promise; } return "allowed";
  } } } });
  try {
    const first = setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "first" })); await entered.promise;
    const list = commands(setup.input, { operation: "set", path: "/alpha/flag", value: "second" });
    const second = setup.mutations.apply(list); list[0].layer = "evil";
    const next = setup.controller.forIdentity(setup.controller.mint(principal(setup.input, { principalId: "replacement" })), { identity: setup.input.identity, namespace: "/alpha" });
    finish.resolve(); assert.equal((await first).success, true); assert.equal((await second).success, true);
    assert.deepEqual(seen, ["host-verified", "host-verified"]); assert.equal(setup.reader.get(["flag"]), "second");
    assert.equal(next.get(["flag"]), "second");
  } finally { finish.resolve(); await setup.root.dispose(); }
});
test("expiration during real async authorization is rechecked before effects", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  const claims = principal(input, { expiresAt: Date.now() + 150 });
  const setup = await writable({ provider, input, claims, host: { hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite() { await sleep(175); return "allowed"; } } } });
  try { assert.equal((await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "after" }))).error.code, "FORBIDDEN"); assert.equal(provider.writes, 0); }
  finally { await setup.root.dispose(); }
});
test("schema changes queued during authorization publish after the current data command", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  const entered = deferred(), finish = deferred();
  const setup = await writable({ provider, input, host: { hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite(_, request) {
    if (request.operation === "write") { entered.resolve(); await finish.promise; } return "allowed";
  } } } });
  try {
    const pending = setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "after" })); await entered.promise;
    const schemas = setup.controller.forSchemas(setup.controller.mint(schemaClaims(input)));
    const before = schemas.revision;
    const registration = schemas.register(input.schemas[0]);
    assert.equal(schemas.revision, before); finish.resolve();
    assert.equal((await pending).success, true); assert.equal((await registration).success, true);
    assert.equal(provider.writes, 1); assert.notEqual(schemas.revision, before);
  }
  finally { finish.resolve(); await setup.root.dispose(); }
});

test("grants cannot be combined or widened by caller mutation, replacement or foreign tokens", async () => {
  const setup = await writable(), foreign = await writable();
  try {
    assert.throws(() => setup.controller.forMutations(foreign.token), { code: "FORBIDDEN" });
    assert.throws(() => setup.controller.forIdentity({}, { identity: setup.input.identity, namespace: "/alpha" }), { code: "FORBIDDEN" });
    const original = principal(setup.input), grant = original.grants[0];
    const split = { ...original, grants: [{ ...grant, operations: ["write"], layers: [] }, { ...grant, operations: ["read", "inspect"] }] };
    const token = setup.controller.mint(split);
    split.grants[0].layers.push("base");
    assert.equal((await setup.controller.forMutations(token).apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "no" }))).error.code, "FORBIDDEN");
    const port = setup.controller.forMutations(setup.token);
    const next = setup.controller.replace(setup.token, original);
    assert.equal(setup.controller.forIdentity(next, { identity: setup.input.identity, namespace: "/alpha" }).get(["flag"]), "before");
    assert.equal((await port.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "no" }))).error.code, "FORBIDDEN");
    const wrong = setup.controller.mint({ ...original, grants: [{ ...grant, namespace: "/alpha-other" }] });
    assert.throws(() => setup.controller.forIdentity(wrong, { identity: setup.input.identity, namespace: "/alpha" }), { code: "FORBIDDEN" });
    assert.equal((await setup.controller.forMutations(wrong).apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "no" }))).error.code, "FORBIDDEN");
    assert.equal(setup.provider.writes, 0);
  } finally { await setup.root.dispose(); await foreign.root.dispose(); }
});
test("raw hidden siblings validate without public projection leaks; tainted references cannot be overwritten", async () => {
  const provider = new WritableMemory("disk", "base", { alpha: { flag: "before", hidden: { a: "PRIVATE-INVALID" } } });
  const setup = await writable({ provider });
  try {
    const result = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "after" }));
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
      assert.equal((await other.mutations.apply(commands(input, { operation: "set", path, value: path.endsWith("key") ? "after" : 2 }))).error.code, "FORBIDDEN");
    assert.equal(provider.writes, 0);
    assert.equal((await other.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "public" }))).success, true);
    assert.equal(other.reader.get(["flag"]), "public");
  } finally { await other.root.dispose(); }
});
test("rank drift and thrown/malformed authorization fail closed", async () => {
  for (const decision of [() => { throw Error("PRIVATE"); }, () => ({ allowed: true }), () => false]) {
    const setup = await writable({ host: { hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: decision } } });
    try { const result = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "after" })); assert.equal(result.error.code, "FORBIDDEN"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); assert.equal(setup.provider.writes, 0); }
    finally { await setup.root.dispose(); }
  }
  const provider = new WritableMemory(), input = writableOptions([provider]), config = authConfig(input);
  let drift = false; config.weaverConfig = { ...config.weaverConfig, getRank: () => drift ? 9 : 0 };
  const setup = await writable({ provider, input, host: { authConfig: config, audit: (record) => { if (record.phase === "before-dispatch") drift = true; } } });
  try { assert.equal((await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "after" }))).success, false); assert.equal(provider.writes, 0); }
  finally { await setup.root.dispose(); }
});
test("synchronous hook reentry cannot enqueue a nested mutation or deadlock the FIFO", async () => {
  let setup, nested;
  setup = await writable({ host: { hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite() {
    nested = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "nested" })); return "allowed";
  } } } });
  try {
    assert.equal((await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "outer" }))).success, true);
    assert.equal(nested.error.code, "FORBIDDEN"); assert.equal(setup.provider.writes, 1); assert.equal(setup.reader.get(["flag"]), "outer");
  } finally { await setup.root.dispose(); }
});
test("queued revoked operations never authorize or dispatch and do not poison later work", async () => {
  const entered = deferred(), finish = deferred(); let authorizations = 0;
  const setup = await writable({ host: { hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite() {
    authorizations++; if (authorizations === 1) { entered.resolve(); await finish.promise; } return "allowed";
  } } } });
  try {
    const first = setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "first" })); await entered.promise;
    const second = setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "second" }));
    setup.controller.revoke(setup.token); finish.resolve();
    assert.equal((await first).error.code, "FORBIDDEN"); assert.equal((await second).error.code, "FORBIDDEN");
    assert.equal(authorizations, 1); assert.equal(setup.provider.writes, 0);
    const fresh = setup.controller.mint(principal(setup.input));
    assert.equal((await setup.controller.forMutations(fresh).apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "third" }))).success, true);
  } finally { finish.resolve(); await setup.root.dispose(); }
});
test("schema publication queued after data dispatch preserves the known result and reprojects", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  const entered = deferred(), finish = deferred(), original = provider.write;
  provider.write = async function (key, value) { const result = await original.call(this, key, value); entered.resolve(); await finish.promise; return result; };
  const setup = await writable({ provider, input });
  try {
    const pending = setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "committed" })); await entered.promise;
    const request = structuredClone(input.schemas[0]); request.schema.properties.flag["x-weaver"] = { sensitive: true };
    const registration = setup.controller.forSchemas(setup.controller.mint(schemaClaims(input))).register(request);
    finish.resolve(); const result = await pending; assert.equal((await registration).success, true);
    assert.equal(result.success, true); assert.equal(provider.entries.alpha.flag, "committed");
    assert.throws(() => setup.reader.get(["flag"]), { code: "FORBIDDEN" });
    assert.equal((await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "never" }))).error.code, "FORBIDDEN");
    assert.equal(provider.writes, 1);
  } finally { await setup.root.dispose(); }
});
test("public overrides cannot authorize destructive raw ancestors outside a child-only grant", async () => {
  for (const atomic of [null, [1, 2], "atomic"]) {
    const base = new WritableMemory("disk", "base", { alpha: { cfg: atomic } });
    const overlay = new WritableMemory("overlay", "overlay", { alpha: { cfg: { a: 99 } } });
    const input = writableOptions([base, overlay]);
    const claims = principal(input); claims.grants[0].namespace = "/alpha/cfg/a";
    const setup = await writable({ provider: base, input, claims, readerClaims: principal(input) });
    try {
      assert.equal(setup.reader.get(["cfg", "a"]), 99);
      const revision = setup.reader.revision;
      assert.equal((await setup.mutations.apply(commands(input, { namespace: "/alpha/cfg/a", operation: "set", path: "/alpha/cfg/a", value: 2 }))).error.code, Array.isArray(atomic) ? "UNSUPPORTED_OPERATION" : "FORBIDDEN");
      assert.equal(base.writes, 0); assert.deepEqual(base.entries.alpha.cfg, atomic); assert.equal(setup.reader.revision, revision);
    } finally { await setup.root.dispose(); }
  }
});
test("session-bearing principals and explicitly configured session layers cannot enable writes", async () => {
  for (const principalSession of [true, false]) {
    const provider = new WritableMemory(), input = writableOptions([provider]), config = authConfig(input);
    const claims = principal(input);
    if (principalSession) claims.session = { mode: "emergency-override", overrideReason: "host reason" };
    else config.sessionLayer = "base";
    const setup = await writable({ provider, input, claims: principal(input), host: { authConfig: config } });
    try {
      if (principalSession) assert.throws(() => setup.controller.mint(claims), { code: "VALIDATION_ERROR" });
      else assert.equal((await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "never" }))).error.code, "POLICY_VIOLATION");
      assert.equal(provider.writes, 0);
    } finally { await setup.root.dispose(); }
  }
});
