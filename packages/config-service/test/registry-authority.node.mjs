import assert from "node:assert/strict";
import test from "node:test";
import { hosted, principal } from "./fixtures/authority.mjs";
import { schemaClaims } from "./fixtures/live-registry.mjs";
import { deferred, registration } from "./fixtures/memory.mjs";

test("schema grants are independent from config operations and cannot be forged across roots", async () => {
  const a = await hosted(), b = await hosted();
  try {
    const claims = schemaClaims(a.input), token = a.controller.mint(claims);
    const schemas = a.controller.forSchemas(token);
    for (const name of ["root", "registry", "controller", "token", "prepare", "publish", "provider"])
      assert.equal(Object.hasOwn(schemas, name), false);
    claims.schemaPermissions.length = 0; claims.grants.length = 0;
    assert.equal(schemas.snapshot().anchors.length, 4);
    assert.throws(() => a.controller.forIdentity(token, { identity: a.input.identity, namespace: "/alpha" }), { code: "FORBIDDEN" });
    const dataOnly = a.controller.forSchemas(a.controller.mint(principal(a.input)));
    assert.throws(() => dataOnly.snapshot(), { code: "FORBIDDEN" });
    assert.equal((await dataOnly.register(a.input.schemas[0])).error.code, "FORBIDDEN");
    for (const fake of [{}, { ...token }, b.controller.mint(schemaClaims(b.input)), null])
      assert.throws(() => a.controller.forSchemas(fake), { code: "FORBIDDEN" });
    a.controller.revoke(token);
    assert.throws(() => schemas.snapshot(), { code: "FORBIDDEN" });
    assert.equal((await schemas.register(a.input.schemas[0])).error.code, "FORBIDDEN");
  } finally { await a.root.dispose(); await b.root.dispose(); }
});

test("read/register separation, exact namespace/environment and root scope constrain schema administration", async () => {
  const { root, controller, input } = await hosted();
  try {
    const read = controller.forSchemas(controller.mint(schemaClaims(input, ["read"])));
    assert.equal((await read.register(input.schemas[0])).error.code, "FORBIDDEN");
    const write = controller.forSchemas(controller.mint(schemaClaims(input, ["register"])));
    assert.throws(() => write.snapshot(), { code: "FORBIDDEN" });
    assert.equal((await write.register(input.schemas[0])).success, true);
    const claims = schemaClaims(input); claims.grants = [claims.grants[0]];
    const confined = controller.forSchemas(controller.mint(claims));
    assert.ok(confined.get("/alpha", "east").detail);
    for (const read of [() => confined.get("/alpha", "west"), () => confined.get("/beta", "east"),
      () => confined.snapshot(), () => confined.list({ limit: 1 })]) assert.throws(read, { code: "FORBIDDEN" });
    for (const request of [registration("west"), registration("east", "beta"), registration("east", "alphabeta")])
      assert.equal((await confined.register(request)).error.code, "FORBIDDEN");
    claims.grants[0].identity.scopePath = [{ scopeId: "tenant", value: "one" }];
    const scoped = controller.forSchemas(controller.mint(claims));
    assert.equal((await scoped.register(input.schemas[0])).error.code, "FORBIDDEN");
    assert.equal(input.providers[0].provider.writes, 0);
  } finally { await root.dispose(); }
});

test("sync schema authorization rejects promises, throws and malformed decisions without disclosure", async () => {
  for (const decision of [() => Promise.resolve("allowed"), () => Promise.reject(Error("SECRET")),
    () => { throw Error("SECRET"); }, () => ({ allowed: true }), () => "denied"]) {
    const { root, controller, input } = await hosted(undefined, { hostAuthority: { authorizeReadSync: decision, authorizeWrite: async () => "allowed" } });
    try {
      const schemas = controller.forSchemas(controller.mint(schemaClaims(input)));
      for (const read of [() => schemas.revision, () => schemas.snapshot(), () => schemas.list(), () => schemas.get("/alpha", "east")])
        assert.throws(read, (error) => { assert.equal(error.code, "FORBIDDEN"); assert.doesNotMatch(JSON.stringify(error), /SECRET/); return true; });
    } finally { await root.dispose(); }
  }
});

test("schema request/option getters never run; revocation and expiry around awaited callbacks deny effects", async () => {
  for (const expire of [false, true]) {
    let now = 0, getters = 0;
    const entered = deferred(), finish = deferred();
    const { root, controller, input } = await hosted(undefined, { now: () => now,
      hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => { entered.resolve(); await finish.promise; return "allowed"; } } });
    const token = controller.mint({ ...schemaClaims(input), expiresAt: 10 }), schemas = controller.forSchemas(token);
    const reader = controller.forIdentity(controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
    try {
      assert.equal((await schemas.register({ get schema() { getters++; return {}; } })).success, false);
      assert.equal((await schemas.register(input.schemas[0], { get ifRevision() { getters++; return "x"; } })).success, false);
      assert.equal(getters, 0);
      const before = reader.revision, pending = schemas.register(input.schemas[0]); await entered.promise;
      if (expire) now = 10; else controller.revoke(token);
      finish.resolve(); assert.equal((await pending).error.code, "FORBIDDEN");
      assert.equal(reader.revision, before); assert.equal(input.providers[0].provider.writes, 0);
    } finally { finish.resolve(); await root.dispose(); }
  }
});
