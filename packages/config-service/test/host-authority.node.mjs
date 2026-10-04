import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createCanonicalSchemaRegistry } from "@weaver-conf/config-registry";
import { configurationAuthorityCapabilitySchema, configurationServiceOptionsSchema } from "@weaver-conf/config-types";
import { createConfigurationService, configurationServiceHostOptionsSchema } from "../dist/index.js";
import { authConfig, hosted, principal } from "./fixtures/authority.mjs";
import { deferred, MemoryProvider, options, registration, scopeOptions } from "./fixtures/memory.mjs";
import { withConsumer } from "./fixtures/packed-consumer.mjs";

test("host-only opaque mint/bind/request/revoke with detached claims and no write effects", async () => {
  const setup = await hosted(); const { root, controller, input, calls } = setup;
  try {
    const claims = principal(input), token = controller.mint(claims);
    assert.deepEqual(Reflect.ownKeys(token), []); assert.ok(Object.isFrozen(token));
    assert.equal(configurationAuthorityCapabilitySchema.safeParse(token).success, false);
    const port = controller.forIdentity(token, input.identity, "/alpha");
    claims.roles.push("mutated"); claims.grants[0].identity.environment = "west";
    claims.grants[0].identity.scopePath.push({ scopeId: "other", value: "other" });
    claims.grants[0].namespace = "/beta"; claims.grants[0].layers.length = 0;
    await port.prepare(); assert.equal(port.get("/alpha/flag"), "public");
    assert.equal(port.inspect("/alpha/flag").revision, port.revision);
    assert.throws(() => port.get("/beta/flag"), { code: "FORBIDDEN" });
    controller.bindRoot(token); assert.equal(root.get("/alpha/flag"), "public");
    for (const target of [root, port]) {
      assert.equal((await target.set("/alpha/flag", "changed", { layer: "base" })).error.code, "WRITE_UNAVAILABLE");
      assert.equal((await target.remove("/alpha/flag", { layer: "base" })).error.code, "WRITE_UNAVAILABLE");
      for (const key of ["controller", "token", "registry", "provider", "transport", "writer"]) assert.equal(Object.hasOwn(target, key), false);
    }
    assert.equal(calls.writes, 0); assert.equal(calls.ready, 1);
    const provider = input.providers[0].provider;
    assert.equal(provider.loads, 1); assert.equal(provider.writes + provider.removes + provider.flushes, 0);
    controller.revoke(token);
    for (const read of [() => port.get("/alpha/flag"), () => port.inspect("/alpha/flag"), () => port.revision, () => root.get("/alpha/flag"), () => root.revision]) assert.throws(read, { code: "FORBIDDEN" });
    await assert.rejects(port.prepare(), { code: "FORBIDDEN" });
  } finally { await root.dispose(); }
  assert.throws(() => controller.mint(principal(input)), { code: "DISPOSED" });
});

test("forged/copy/serialized/cross-root capabilities and replacement never upgrade old handles", async () => {
  const west = options([new MemoryProvider("west", "base", { alpha: { flag: "western" } })], { identity: { environment: "west", scopePath: [] } });
  const a = await hosted(), b = await hosted(west);
  try {
    const token = a.controller.mint(principal(a.input));
    for (const fake of [{}, { ...token }, JSON.parse(JSON.stringify(token)), b.controller.mint(principal(b.input)), Object.create(token), null]) {
      assert.throws(() => a.controller.bindRoot(fake), { code: "FORBIDDEN" });
      assert.throws(() => a.controller.forIdentity(fake, a.input.identity, "/alpha"), { code: "FORBIDDEN" });
    }
    const old = a.controller.forIdentity(token, a.input.identity, "/alpha");
    const claims = principal(a.input); claims.grants[0].namespace = "/beta";
    const replacement = a.controller.replace(token, claims); claims.grants[0].namespace = "/alpha";
    assert.throws(() => old.get("/alpha/flag"), { code: "FORBIDDEN" });
    const next = a.controller.forIdentity(replacement, a.input.identity, "/beta");
    assert.equal(next.get("/beta/flag"), "other");
    assert.throws(() => next.get("/alpha/flag"), { code: "FORBIDDEN" });
    assert.notEqual(a.root.revision, b.root.revision);
  } finally { await a.root.dispose(); await b.root.dispose(); }
});

test("controlled expiry and post-callback revocation are checked on synchronous reads", async () => {
  let now = 10, snapshotSeen, requestSeen, revoke;
  const setup = await hosted(undefined, { now: () => now, hostAuthority: {
    authorizeReadSync(snapshot, request) { snapshotSeen = snapshot; requestSeen = request; revoke?.(); return "allowed"; },
    async authorizeWrite() { throw Error("must never execute"); },
  } });
  const { controller, root, input } = setup;
  try {
    const token = controller.mint(principal(input, { expiresAt: 20 }));
    const port = controller.forIdentity(token, input.identity, "/alpha");
    assert.equal(port.get("/alpha/flag"), "public");
    assert.ok(Object.isFrozen(snapshotSeen.grants[0].identity.scopePath));
    assert.ok(Object.isFrozen(snapshotSeen.roles)); assert.ok(Object.isFrozen(requestSeen));
    assert.deepEqual(Object.keys(requestSeen).sort(), ["identity", "namespace", "operation", "path", "sensitive"]);
    now = 20; assert.throws(() => port.get("/alpha/flag"), { code: "FORBIDDEN" });
    const fresh = controller.mint(principal(input)); const freshPort = controller.forIdentity(fresh, input.identity, "/alpha");
    now = NaN; assert.throws(() => freshPort.get("/alpha/flag"), { code: "FORBIDDEN" }); now = 10;
    revoke = () => controller.revoke(fresh);
    assert.throws(() => freshPort.get("/alpha/flag"), { code: "FORBIDDEN" });
  } finally { await root.dispose(); }
});

test("every bound root read surface denies thrown, Promise, malformed and denied decisions", async () => {
  for (const decide of [() => "denied", () => { throw Error("PRIVATE"); }, () => Promise.resolve("allowed"), () => Promise.reject(Error("PRIVATE")), () => ({ allowed: true }), () => undefined]) {
    const { root, controller, input } = await hosted(undefined, { hostAuthority: { authorizeReadSync: decide, async authorizeWrite() { return "allowed"; } } });
    try {
      assert.equal(root.get("/beta/flag"), "other");
      controller.bindRoot(controller.mint(principal(input)));
      for (const read of [() => root.get("/alpha/flag"), () => root.getWithDefault("/alpha/missing", "fallback"), () => root.getAtLayer("base", "/alpha/flag"), () => root.getNamespace("/alpha"), () => root.getForScope("/alpha/flag", []), () => root.inspect("/alpha/flag"), () => root.onChange("/alpha/flag", () => {})]) {
        assert.throws(read, (error) => { assert.equal(error.code, "FORBIDDEN"); assert.doesNotMatch(JSON.stringify(error), /PRIVATE/); return true; });
      }
      await assert.rejects(root.preloadScope([]), { code: "FORBIDDEN" });
      assert.equal(input.providers[0].provider.loads, 1);
    } finally { await root.dispose(); }
  }
});

test("allowed host roles never bypass public projection, aggregate/view or exact layer grants", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "public", cfg: { a: 1 }, hidden: { a: "PRIVATE" }, secret: { _weaver: "secret-ref", key: "PRIVATE" }, alias: { _weaver: "mount", path: "/alpha/hidden" } } });
  const input = options([provider]);
  input.schemas[0].schema.properties.admin = { type: "string", "x-weaver": { visibility: "admin" } };
  input.schemas[0].schema.properties.instances = { type: "object", properties: { x: { type: "string" } } };
  const { root, controller } = await hosted(input);
  try {
    const claims = principal(input); claims.grants[0].sensitive = true; claims.grants[0].views = ["view-one", "view-two"];
    controller.bindRoot(controller.mint(claims));
    assert.equal(root.get("/alpha/flag"), "public"); assert.equal(root.getWithDefault("/alpha/missing", "fallback"), "fallback");
    assert.equal(root.getAtLayer("base", "/alpha/flag"), "public");
    for (const path of ["/alpha", "/alpha/cfg", "/alpha/list", "/alpha/hidden/a", "/alpha/admin", "/alpha/instances/x", "/alpha/secret/key", "/alpha/alias/a", "/beta/flag"]) assert.throws(() => root.get(path), { code: "FORBIDDEN" });
    assert.throws(() => root.getNamespace("/alpha"), { code: "FORBIDDEN" });
    assert.throws(() => root.getAtLayer("other", "/alpha/flag"), { code: "FORBIDDEN" });
    assert.throws(() => root.inspect("/alpha/hidden/a"), { code: "FORBIDDEN" });
    assert.throws(() => root.getWithDefault("/unknown/path", "fallback"), { code: "FORBIDDEN" });
  } finally { await root.dispose(); }
});

test("exact environment, ordered tuple, namespace and single complete grant constrain preparation", async () => {
  const setup = scopeOptions(); const { root, controller } = await hosted(setup.input);
  try {
    const claims = principal(setup.input); claims.grants[0].identity.scopePath = structuredClone(setup.path1);
    const token = controller.mint(claims);
    const identity = { environment: "east", scopePath: setup.path1 };
    const port = controller.forIdentity(token, identity, "/alpha");
    assert.throws(() => port.get("/alpha/flag"), { code: "SCOPE_NOT_LOADED" });
    for (const selection of [{ environment: "west", scopePath: setup.path1 }, { environment: "east", scopePath: setup.path2 }]) assert.throws(() => controller.forIdentity(token, selection, "/alpha"), { code: "FORBIDDEN" });
    for (const ns of ["/", "/alph", "/alpha/cfg", "/beta"]) assert.throws(() => controller.forIdentity(token, identity, ns), { code: "FORBIDDEN" });
    assert.throws(() => controller.bindRoot(token), { code: "FORBIDDEN" });
    assert.equal(setup.first.loads + setup.second.loads, 0);
    await port.prepare(); assert.equal(port.get("/alpha/flag"), "one");
    const split = principal(setup.input); split.grants[0].identity.scopePath = structuredClone(setup.path2);
    split.grants[0].layers = ["base"]; split.grants.push({ ...split.grants[0], layers: ["scope", "last"] });
    const partial = controller.forIdentity(controller.mint(split), split.grants[0].identity, "/alpha");
    await assert.rejects(partial.prepare(), { code: "FORBIDDEN" }); assert.equal(setup.second.loads, 0);
    const ordered = principal(setup.input); ordered.grants[0].identity.scopePath = [{ scopeId: "constructor", value: "toString" }, { scopeId: "area", value: "雪,:" }];
    const orderToken = controller.mint(ordered);
    assert.throws(() => controller.forIdentity(orderToken, { environment: "east", scopePath: [...ordered.grants[0].identity.scopePath].reverse() }, "/alpha"), { code: "FORBIDDEN" });
  } finally { await root.dispose(); }
});

test("revocation/expiry during delayed preparation cannot publish, rebind cannot switch queued identity authority", async () => {
  for (const expire of [false, true]) {
    let now = 0; const gate = deferred(), setup = scopeOptions({ firstGate: gate });
    const { root, controller } = await hosted(setup.input, { now: () => now });
    try {
      const claims = principal(setup.input, { expiresAt: 10 }); claims.grants.push({ ...claims.grants[0], identity: { environment: "east", scopePath: setup.path1 } });
      const token = controller.mint(claims); controller.bindRoot(token);
      const pending = root.preloadScope(setup.path1); const rejected = assert.rejects(pending, { code: "FORBIDDEN" });
      await Promise.resolve(); assert.equal(setup.first.loads, 1);
      if (expire) now = 10; else controller.revoke(token);
      controller.bindRoot(controller.mint(principal(setup.input)));
      gate.resolve(); await rejected;
      const replacement = principal(setup.input); replacement.grants[0].identity.scopePath = setup.path1;
      const port = controller.forIdentity(controller.mint(replacement), replacement.grants[0].identity, "/alpha");
      assert.throws(() => port.get("/alpha/flag"), { code: "SCOPE_NOT_LOADED" });
      assert.equal(root.get("/alpha/flag"), "base");
      assert.equal(setup.first.writes + setup.first.removes + setup.first.flushes, 0);
    } finally { gate.resolve(); await root.dispose(); }
  }
});

test("injected real canonical reader is used directly, conflicts and durable ceilings reject before IO", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "public" } });
  const input = options([provider]), registry = createCanonicalSchemaRegistry({ defaultEnvironment: "east" });
  for (const schema of input.schemas) assert.equal(registry.register(schema).success, true);
  let calls = 0; const original = registry.resolveAnchor;
  registry.resolveAnchor = function (...args) { assert.equal(this, registry); calls++; return original.apply(this, args); };
  registry.register = () => { throw Error("must not re-register"); };
  await assert.rejects(createConfigurationService(input, { registry }), { code: "VALIDATION_ERROR" }); assert.equal(provider.loads, 0);
  const hostedInput = { ...input, schemas: [] }; const { root, controller } = await hosted(hostedInput, { registry });
  try {
    controller.bindRoot(controller.mint(principal(input)));
    const before = calls; assert.equal(root.get("/alpha/flag"), "public"); assert.ok(calls > before);
    assert.equal(provider.loads, 1);
  } finally { await root.dispose(); }
  const ceilings = createCanonicalSchemaRegistry({ defaultEnvironment: "east" });
  assert.equal(ceilings.register(registration("west", "other", { type: "object", properties: { absent: { type: "string", "x-weaver": { maxOverrideLayer: "base" } } } })).success, true);
  await assert.rejects(createConfigurationService(hostedInput, { registry: ceilings }), { code: "UNSUPPORTED_OPERATION" }); assert.equal(provider.loads, 1);
});

test("host preflight is own-data/native shape, missing AuthConfig and malformed ranks deny before hooks", async () => {
  const provider = new MemoryProvider("p", "base", {}), input = options([provider]); let getters = 0, hooks = 0;
  const base = { authConfig: authConfig(input), hostAuthority: { authorizeReadSync() { hooks++; return "allowed"; }, async authorizeWrite() { hooks++; return "allowed"; } } };
  const bad = [null, { hostAuthority: base.hostAuthority }, { ...base, extra: true }, { ...base, hostAuthority: { ...base.hostAuthority, extra: true } }, { ...base, get now() { getters++; return () => 0; } }, { ...base, writers: [{ providerId: "p", operation: { kind: "write" }, flush: "none", failureSemantics: "unknown", actor: "untrusted" }] }];
  for (const host of bad) await assert.rejects(createConfigurationService(input, host), { code: "VALIDATION_ERROR" });
  const wrong = authConfig(input); wrong.weaverConfig.getRank = () => 10;
  await assert.rejects(createConfigurationService(input, { ...base, authConfig: wrong }), { code: "VALIDATION_ERROR" });
  const constrained = authConfig(input); constrained.layerWritePolicies[0].constraints = [{ scopeRestriction: "own-user" }];
  await assert.rejects(createConfigurationService(input, { ...base, authConfig: constrained }), { code: "VALIDATION_ERROR" });
  assert.equal(provider.loads + hooks + getters, 0);
  assert.equal(configurationServiceOptionsSchema.safeParse({ ...input, hostAuthority: base.hostAuthority }).success, false);
  assert.equal(configurationServiceHostOptionsSchema.safeParse(base).success, true);
  assert.equal(Object.isFrozen(base.hostAuthority.authorizeReadSync), false);
});

test("trusted class authority preserves receiver; principal descriptor hazards never execute", async () => {
  class Authority { reads = 0; authorizeReadSync() { this.reads++; return "allowed"; } async authorizeWrite() { throw Error("unexpected"); } }
  let bindGetters = 0; const hostAuthority = new Authority();
  Object.defineProperty(hostAuthority.authorizeReadSync, "bind", { get() { bindGetters++; throw Error("unapproved getter"); } });
  const { root, controller, input } = await hosted(undefined, { hostAuthority });
  try {
    let getters = 0; const claims = principal(input); Object.defineProperty(claims.roles, "0", { get() { getters++; return "reader"; } });
    assert.throws(() => controller.mint(claims), { code: "VALIDATION_ERROR" }); assert.equal(getters, 0);
    const extra = principal(input); extra.grants[0].actor = "untrusted"; assert.throws(() => controller.mint(extra), { code: "VALIDATION_ERROR" });
    const exotic = principal(input); Object.setPrototypeOf(exotic.grants, Object.create(Array.prototype)); assert.throws(() => controller.mint(exotic), { code: "VALIDATION_ERROR" });
    const hidden = principal(input); Object.defineProperty(hidden.roles, "0", { enumerable: false }); assert.throws(() => controller.mint(hidden), { code: "VALIDATION_ERROR" });
    controller.bindRoot(controller.mint(principal(input))); assert.equal(root.get("/alpha/flag"), "public");
    assert.equal(hostAuthority.reads, 1); assert.equal(bindGetters, 0); assert.equal(Object.isFrozen(hostAuthority), false);
  } finally { await root.dispose(); }
});

test("controller callback failure fences pending work and cleans every owned hook once with sanitized primary error", async () => {
  const setup = scopeOptions(); const closed = []; let controller, pending;
  setup.input.providers[0].ownership = { kind: "owned", dispose() { closed.push("base"); throw Error("PRIVATE"); } };
  setup.input.providers[1].ownership = { kind: "owned", dispose() { closed.push("scope"); } };
  await assert.rejects(hosted(setup.input, { onAuthorityReady(value) {
    controller = value; const claims = principal(setup.input); claims.grants[0].identity.scopePath = setup.path1;
    pending = value.forIdentity(value.mint(claims), claims.grants[0].identity, "/alpha").prepare(); pending.catch(() => {});
    throw Error("PRIVATE");
  } }), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR"); assert.deepEqual(error.details.cleanupFailedResources, ["base"]);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE/); return true;
  });
  await assert.rejects(pending, { code: "DISPOSED" }); assert.deepEqual(closed, ["base", "scope"]);
  assert.equal(setup.first.loads, 0); assert.throws(() => controller.mint(principal(setup.input)), { code: "DISPOSED" });
});

test("packed installed ESM/CJS host API really mints, reads and revokes without enabling writer", async () => {
  await withConsumer(async (directory) => {
    const require = createRequire(join(directory, "package.json"));
    for (const cjs of [false, true]) {
      const service = cjs ? require("@weaver-conf/config-service") : await import(pathToFileURL(require.resolve("@weaver-conf/config-service").replace(/\.cjs$/, ".js")));
      const { root, controller, input } = await hosted(undefined, {}, service.createConfigurationService);
      try {
        const token = controller.mint(principal(input)); controller.bindRoot(token);
        assert.equal(root.get("/alpha/flag"), "public"); assert.equal(root.inspect("/alpha/flag").effective.value, "public");
        assert.equal((await root.remove("/alpha/flag", { layer: "base" })).error.code, "WRITE_UNAVAILABLE");
        controller.revoke(token); assert.throws(() => root.get("/alpha/flag"), { code: "FORBIDDEN" });
      } finally { await root.dispose(); }
    }
  });
});

test("two selected ordered scopes stay detached and scoped ports share the published generation", async () => {
  const setup = scopeOptions();
  const full = [...setup.path1, { scopeId: "group", value: "toString" }];
  setup.input.providers[2].scopePath = structuredClone(full);
  const { root, controller } = await hosted(setup.input);
  try {
    const claims = principal(setup.input); claims.grants[0].identity.scopePath = structuredClone(full);
    const token = controller.mint(claims);
    const selection = { environment: "east", scopePath: structuredClone(full) };
    const port = controller.forIdentity(token, selection, "/alpha");
    selection.scopePath.reverse(); claims.grants[0].identity.scopePath[0].value = "changed";
    const initial = root.revision; await port.prepare();
    assert.equal(port.get("/alpha/flag"), "two"); assert.equal(port.inspect("/alpha/flag").revision, port.revision);
    assert.deepEqual(port.identity.scopePath, full); assert.equal(root.revision, initial);
    assert.equal(root.getForScope("/alpha/flag", full), "two");
    assert.equal(setup.first.loads, 1); assert.equal(setup.second.loads, 1);
  } finally { await root.dispose(); }
});

test("unsupported session and partial operations cannot authorize inspection or preparation", async () => {
  const { root, controller, input } = await hosted();
  try {
    const session = principal(input, { session: { mode: "emergency-override", overrideReason: "host request" } });
    assert.throws(() => controller.forIdentity(controller.mint(session), input.identity, "/alpha"), { code: "FORBIDDEN" });
    const claims = principal(input); claims.grants[0].operations = ["read"];
    const token = controller.mint(claims); controller.bindRoot(token);
    assert.equal(root.get("/alpha/flag"), "public");
    assert.throws(() => root.inspect("/alpha/flag"), { code: "FORBIDDEN" });
    assert.throws(() => root.get("/alpha/not-declared"), { code: "SCHEMA_NOT_REGISTERED" });
    const writeOnly = principal(input); writeOnly.grants[0].operations = ["write"];
    const port = controller.forIdentity(controller.mint(writeOnly), input.identity, "/alpha");
    await assert.rejects(port.prepare(), { code: "FORBIDDEN" });
    assert.equal((await port.remove("/alpha/flag", { layer: "base" })).error.code, "WRITE_UNAVAILABLE");
    assert.throws(() => controller.replace(token, { principalId: "invalid" }), { code: "VALIDATION_ERROR" });
    assert.throws(() => root.get("/alpha/flag"), { code: "FORBIDDEN" });
  } finally { await root.dispose(); }
});

test("canonical registry lifetime changes fail closed instead of mixing projections with new declarations", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "public" } }), input = options([provider]);
  const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "east" });
  for (const request of input.schemas) assert.equal(registry.register(request).success, true);
  const { root, controller } = await hosted({ ...input, schemas: [] }, { registry });
  const token = controller.mint(principal(input)); controller.bindRoot(token);
  assert.equal(root.get("/alpha/flag"), "public");
  assert.equal(registry.register(registration("east", "new-service")).success, true);
  try {
    assert.throws(() => root.get("/alpha/flag"), { code: "FORBIDDEN" });
    assert.throws(() => root.inspect("/alpha/flag"), { code: "FORBIDDEN" });
    assert.equal(provider.loads, 1);
  } finally { await root.dispose(); }
});

test("disposal fences host ports and waits active preparation before all owned hooks", async () => {
  const gate = deferred(), setup = scopeOptions({ firstGate: gate }); let closed = 0;
  setup.input.providers[1].ownership = { kind: "owned", dispose() { closed++; } };
  const { root, controller } = await hosted(setup.input);
  const claims = principal(setup.input); claims.grants[0].identity.scopePath = setup.path1;
  const port = controller.forIdentity(controller.mint(claims), claims.grants[0].identity, "/alpha");
  const pending = port.prepare(), rejection = assert.rejects(pending, { code: "DISPOSED" });
  await Promise.resolve(); assert.equal(setup.first.loads, 1);
  const disposal = root.dispose(); assert.equal(closed, 0); assert.equal(root.dispose(), disposal);
  gate.resolve(); await rejection; assert.equal((await disposal).ok, true); assert.equal(closed, 1);
  assert.throws(() => port.get("/alpha/flag"), { code: "DISPOSED" });
  assert.equal((await port.set("/alpha/flag", "after", { layer: "scope" })).error.code, "DISPOSED");
});

test("audit/async-write ports without writer opt-in remain unavailable without effects", async () => {
  let audits = 0, writes = 0; const input = options([new MemoryProvider("p", "base", { alpha: { flag: "before" } })]);
  const { root, controller } = await hosted(input, {
    audit() { audits++; throw Error("must not execute"); },
    hostAuthority: { authorizeReadSync() { return "allowed"; }, async authorizeWrite() { writes++; return "allowed"; } },
  });
  try {
    const token = controller.mint(principal(input)), port = controller.forIdentity(token, input.identity, "/alpha"); controller.bindRoot(token);
    assert.equal((await root.set("/alpha/flag", "after", { layer: "base" })).error.code, "WRITE_UNAVAILABLE");
    assert.equal((await port.remove("/alpha/flag", { layer: "base" })).error.code, "WRITE_UNAVAILABLE");
    assert.equal(root.get("/alpha/flag"), "before"); assert.equal(audits + writes, 0);
    assert.equal(input.providers[0].provider.flushes, 0);
  } finally { await root.dispose(); }
});

test("host callback reentrancy and asynchronous readiness are rejected without raw callback errors", async () => {
  let root, reenter = false;
  const setup = await hosted(undefined, { hostAuthority: {
    authorizeReadSync() { if (reenter) root.get("/alpha/flag"); return "allowed"; }, async authorizeWrite() { return "allowed"; },
  } }); root = setup.root;
  try {
    setup.controller.bindRoot(setup.controller.mint(principal(setup.input))); reenter = true;
    assert.throws(() => root.get("/alpha/flag"), { code: "FORBIDDEN" });
  } finally { await root.dispose(); }
  const input = options([new MemoryProvider("p", "base", {})]); let closed = 0;
  input.providers[0].ownership = { kind: "owned", dispose() { closed++; } };
  await assert.rejects(hosted(input, { async onAuthorityReady() { throw Error("PRIVATE"); } }), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR"); assert.doesNotMatch(JSON.stringify(error), /PRIVATE/); return true;
  }); assert.equal(closed, 1);
});

test("host-owned intrinsic containers cannot execute caller iterator getters during capture", async () => {
  for (const field of ["roles", "ranks"]) {
    let getters = 0, callbacks = 0;
    const provider = new MemoryProvider("p", "base", {}), input = options([provider]);
    const config = authConfig(input), container = field === "roles" ? config.dynamicScopeRoles : config.weaverConfig.rankMap;
    Object.defineProperty(container, Symbol.iterator, { get() { getters++; return field === "roles" ? Set.prototype.values : Map.prototype.entries; } });
    const host = { authConfig: config, hostAuthority: { authorizeReadSync() { callbacks++; return "allowed"; }, async authorizeWrite() { callbacks++; return "allowed"; } } };
    let unexpected;
    try { await assert.rejects(async () => { unexpected = await createConfigurationService(input, host); }, { code: "VALIDATION_ERROR" }); }
    finally { await unexpected?.dispose(); }
    assert.equal(getters + callbacks + provider.loads, 0);
  }
});

test("legacy request ceiling preflight is retained even when later registration replaces the metadata", async () => {
  const provider = new MemoryProvider("p", "base", {}), first = registration();
  first.schema.properties.flag["x-weaver"] = { maxOverrideLayer: "base" };
  const input = options([provider], { schemas: [first, registration()] });
  await assert.rejects(createConfigurationService(input), { code: "UNSUPPORTED_OPERATION" });
  assert.equal(provider.loads, 0);
});

async function disposedAuthorityFixture() {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "public" } }), input = options([provider]);
  const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "east" });
  for (const request of input.schemas) assert.equal(registry.register(request).success, true);
  const calls = { registry: 0, identities: 0, reads: 0, writes: 0, clock: 0, closed: 0 };
  let unavailable = false, now = 0;
  for (const name of ["getSchema", "resolveAnchor", "listAll", "listRegisteredSchemaIdentities", "listRegisteredSchemaIdentityPage", "getRegisteredSchema"]) {
    const original = registry[name];
    registry[name] = function (...args) {
      calls.registry++; if (name === "listRegisteredSchemaIdentities") calls.identities++;
      if (unavailable) throw Error("registry released by host");
      return original.apply(this, args);
    };
  }
  input.providers[0].ownership = { kind: "owned", dispose() { calls.closed++; } };
  const { root, controller } = await hosted({ ...input, schemas: [] }, { registry,
    now() { calls.clock++; return now; },
    hostAuthority: { authorizeReadSync() { calls.reads++; return "allowed"; }, async authorizeWrite() { calls.writes++; return "allowed"; } },
  });
  const valid = controller.mint(principal(input)), revoked = controller.mint(principal(input));
  const expired = controller.mint(principal(input, { expiresAt: 5 }));
  const ports = [valid, revoked, expired].map((token) => controller.forIdentity(token, input.identity, "/alpha"));
  await ports[0].prepare(); assert.equal(ports[0].get("/alpha/flag"), "public");
  assert.ok(calls.identities > 0 && calls.reads > 0); assert.equal(provider.loads, 1);
  controller.revoke(revoked); controller.bindRoot(valid);
  const disposal = root.dispose(); assert.equal((await disposal).ok, true); now = 10;
  return { root, controller, input, provider, registry, calls, ports, tokens: [valid, revoked, expired, {}], disposal,
    releaseRegistry() { unavailable = true; } };
}

async function assertTerminalAuthority(setup) {
  const { root, controller, input, ports, tokens, disposal } = setup;
  for (const port of ports) {
    const before = { ...setup.calls };
    let preparation;
    assert.doesNotThrow(() => { preparation = port.prepare(); });
    assert.ok(preparation instanceof Promise);
    await assert.rejects(preparation, { code: "DISPOSED" });
    assert.deepEqual(setup.calls, before);
    for (const read of [() => port.get("/alpha/flag"), () => port.inspect("/alpha/flag"), () => port.identity, () => port.revision]) assert.throws(read, { code: "DISPOSED" });
    for (const result of [await port.set("/alpha/flag", "changed", { layer: "base" }), await port.remove("/alpha/flag", { layer: "base" })]) assert.equal(result.error.code, "DISPOSED");
  }
  for (const token of tokens) {
    for (const operation of [() => controller.revoke(token), () => controller.replace(token, principal(input)), () => controller.bindRoot(token), () => controller.forIdentity(token, input.identity, "/alpha"), () => controller.forIdentity(token, {}, "invalid")]) assert.throws(operation, { code: "DISPOSED" });
  }
  assert.throws(() => controller.mint({}), { code: "DISPOSED" });
  for (const read of [() => root.get("/alpha/flag"), () => root.getWithDefault("/alpha/missing", "fallback"), () => root.getAtLayer("base", "/alpha/flag"), () => root.getNamespace("/alpha"), () => root.getForScope("/alpha/flag", []), () => root.inspect("/alpha/flag"), () => root.onChange("/alpha/flag", () => {}), () => root.identity, () => root.revision, () => root.mode, () => root.degradedProviders]) assert.throws(read, { code: "DISPOSED" });
  await assert.rejects(root.preloadScope([]), { code: "DISPOSED" });
  for (const result of [await root.set("/alpha/flag", "changed", { layer: "base" }), await root.remove("/alpha/flag", { layer: "base" }), await root.reloadProvider("p"), await root.flush()]) assert.equal(result.error.code, "DISPOSED");
  assert.equal(root.dispose(), disposal);
}

for (const state of ["stable", "changed", "unavailable"]) {
  test(`fresh terminal authority calls fence the ${state} host registry before callbacks`, async () => {
    const setup = await disposedAuthorityFixture();
    if (state === "changed") assert.equal(setup.registry.register(registration("east", "after-close")).success, true);
    if (state === "unavailable") setup.releaseRegistry();
    const before = { ...setup.calls }, providerBefore = { loads: setup.provider.loads, writes: setup.provider.writes, removes: setup.provider.removes, flushes: setup.provider.flushes };
    await assertTerminalAuthority(setup);
    assert.deepEqual(setup.calls, before);
    assert.equal(setup.calls.closed, 1);
    assert.deepEqual({ loads: setup.provider.loads, writes: setup.provider.writes, removes: setup.provider.removes, flushes: setup.provider.flushes }, providerBefore);
  });
}
