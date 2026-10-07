import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { persisted, schemaClaims } from "./fixtures/live-registry.mjs";
import { configurationAuthorityCapabilitySchema, configurationServiceOptionsSchema } from "@weaver-conf/config-types";
import { createConfigurationService, configurationServiceHostOptionsSchema } from "../dist/index.js";
import { authConfig, hosted, principal, readonlyHost } from "./fixtures/authority.mjs";
import { deferred, MemoryProvider, options, registration, scopeOptions } from "./fixtures/memory.mjs";
import { withConsumer } from "./fixtures/packed-consumer.mjs";
import { commands } from "./fixtures/writable-memory.mjs";

test("host-only opaque mint/select/request/revoke with detached claims and no write effects", async () => {
  const setup = await hosted(); const { root, controller, input, calls } = setup;
  try {
    const claims = principal(input), token = controller.mint(claims);
    assert.deepEqual(Reflect.ownKeys(token), []); assert.ok(Object.isFrozen(token));
    assert.equal(configurationAuthorityCapabilitySchema.safeParse(token).success, false);
    const port = controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" });
    claims.roles.push("mutated"); claims.grants[0].identity.environment = "west";
    claims.grants[0].identity.scopePath.push({ scopeId: "other", value: "other" });
    claims.grants[0].namespace = "/beta"; claims.grants[0].layers.length = 0;
    await port.prepare(); assert.equal(port.get(["flag"]), "public");
    assert.equal(port.inspect(["flag"]).revision, port.revision);
    assert.throws(() => controller.forIdentity(token, { identity: input.identity, namespace: "/beta" }), { code: "FORBIDDEN" });
    for (const key of ["get", "inspect", "revision", "identity", "onChange", "preloadScope"]) assert.equal(key in root, false);
    assert.equal("bindRoot" in controller, false);
    for (const target of [root, port]) {
      assert.equal("set" in target, false); assert.equal("remove" in target, false);
      for (const key of ["controller", "token", "registry", "provider", "transport", "writer"]) assert.equal(Object.hasOwn(target, key), false);
    }
    assert.equal(calls.writes, 0); assert.equal(calls.ready, 1);
    const mutations = controller.forMutations(token);
    for (const command of [{ operation: "set", path: "/alpha/flag", value: "changed" }, { operation: "remove", path: "/alpha/flag" }])
      assert.equal((await mutations.apply(commands(input, command))).error.code, "WRITE_UNAVAILABLE");
    const provider = input.providers[0].provider;
    assert.equal(provider.loads, 1); assert.equal(provider.writes + provider.removes + provider.flushes, 0);
    controller.revoke(token);
    for (const read of [() => port.get(["flag"]), () => port.inspect(["flag"]), () => port.snapshot(), () => port.selection, () => port.revision]) assert.throws(read, { code: "FORBIDDEN" });
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
      assert.throws(() => a.controller.forMutations(fake), { code: "FORBIDDEN" });
      assert.throws(() => a.controller.forIdentity(fake, { identity: a.input.identity, namespace: "/alpha" }), { code: "FORBIDDEN" });
    }
    const old = a.controller.forIdentity(token, { identity: a.input.identity, namespace: "/alpha" });
    const initialRevision = old.revision;
    const claims = principal(a.input); claims.grants[0].namespace = "/beta";
    const replacement = a.controller.replace(token, claims); claims.grants[0].namespace = "/alpha";
    assert.throws(() => old.get(["flag"]), { code: "FORBIDDEN" });
    const next = a.controller.forIdentity(replacement, { identity: a.input.identity, namespace: "/beta" });
    assert.equal(next.get(["flag"]), "other");
    assert.throws(() => a.controller.forIdentity(replacement, { identity: a.input.identity, namespace: "/alpha" }), { code: "FORBIDDEN" });
    const other = b.controller.forIdentity(b.controller.mint(principal(b.input)), { identity: b.input.identity, namespace: "/alpha" });
    assert.notEqual(initialRevision, other.revision);
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
    const port = controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" });
    assert.equal(port.get(["flag"]), "public");
    assert.ok(Object.isFrozen(snapshotSeen.grants[0].identity.scopePath));
    assert.ok(Object.isFrozen(snapshotSeen.roles)); assert.ok(Object.isFrozen(requestSeen));
    assert.deepEqual(Object.keys(requestSeen).sort(), ["identity", "namespace", "operation", "path", "sensitive"]);
    now = 20; assert.throws(() => port.get(["flag"]), { code: "FORBIDDEN" });
    const fresh = controller.mint(principal(input)); const freshPort = controller.forIdentity(fresh, { identity: input.identity, namespace: "/alpha" });
    now = NaN; assert.throws(() => freshPort.get(["flag"]), { code: "FORBIDDEN" }); now = 10;
    revoke = () => controller.revoke(fresh);
    assert.throws(() => freshPort.get(["flag"]), { code: "FORBIDDEN" });
  } finally { await root.dispose(); }
});

test("every captured reader surface denies thrown, Promise, malformed and denied decisions", async () => {
  for (const decide of [() => "denied", () => { throw Error("PRIVATE"); }, () => Promise.resolve("allowed"), () => Promise.reject(Error("PRIVATE")), () => ({ allowed: true }), () => undefined]) {
    const { root, controller, input } = await hosted(undefined, { hostAuthority: { authorizeReadSync: decide, async authorizeWrite() { return "allowed"; } } });
    try {
      const reader = controller.forIdentity(controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
      for (const read of [() => reader.get(["flag"]), () => reader.get(["missing"], { defaultValue: "fallback" }), () => reader.get(["flag"], { layer: "base" }), () => reader.get(), () => reader.snapshot(), () => reader.withScope([]).get(["flag"]), () => reader.validate(), () => reader.onChange(["flag"], () => {})]) {
        assert.throws(read, (error) => { assert.equal(error.code, "FORBIDDEN"); assert.doesNotMatch(JSON.stringify(error), /PRIVATE/); return true; });
      }
      assert.deepEqual(reader.inspect(["flag"]).effective, { state: "redacted" });
      assert.doesNotMatch(JSON.stringify(reader.inspect(["flag"])), /PRIVATE|public/);
      await assert.rejects(reader.prepare(), { code: "FORBIDDEN" });
      assert.equal(input.providers[0].provider.loads, 1);
    } finally { await root.dispose(); }
  }
});

test("allowed host roles permit public aggregates but never bypass projection, views or exact layer grants", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "public", cfg: { a: 1 }, hidden: { a: "PRIVATE" }, secret: { _weaver: "secret-ref", key: "PRIVATE" }, alias: { _weaver: "mount", path: "/alpha/hidden" } } });
  const input = options([provider]);
  input.schemas[0].schema.properties.admin = { type: "string", "x-weaver": { visibility: "admin" } };
  input.schemas[0].schema.properties.instances = { type: "object", properties: { x: { type: "string" } } };
  const { root, controller } = await hosted(input);
  try {
    const claims = principal(input); claims.grants.push({ ...claims.grants[0], views: ["view-one", "view-two"] });
    const token = controller.mint(claims), reader = controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" });
    assert.equal(reader.get(["flag"]), "public"); assert.equal(reader.get(["missing"], { defaultValue: "fallback" }), "fallback");
    assert.equal(reader.get(["flag"], { layer: "base" }), "public");
    assert.deepEqual(reader.get(["cfg"]), { a: 1 });
    assert.equal(reader.get(["list"]), undefined);
    for (const path of [["hidden", "a"], ["instances", "x"], ["secret", "key"], ["alias", "a"]]) assert.throws(() => reader.get(path), { code: "FORBIDDEN" });
    assert.deepEqual(reader.get(), { flag: "public", cfg: { a: 1 } });
    assert.equal(reader.get(["admin"]), undefined);
    assert.throws(() => controller.forIdentity(token, { identity: input.identity, namespace: "/beta" }), { code: "FORBIDDEN" });
    assert.throws(() => reader.get(["flag"], { layer: "other" }), { code: "FORBIDDEN" });
    assert.deepEqual(reader.inspect(["hidden", "a"]).effective, { state: "redacted" });
    assert.throws(() => reader.get(["unknown", "path"], { defaultValue: "fallback" }), { code: "SCHEMA_NOT_REGISTERED" });
  } finally { await root.dispose(); }
});

test("exact environment, ordered tuple, namespace and single complete grant constrain preparation", async () => {
  const setup = scopeOptions(); const { root, controller } = await hosted(setup.input);
  try {
    const claims = principal(setup.input); claims.grants[0].identity.scopePath = structuredClone(setup.path1);
    const token = controller.mint(claims);
    const identity = { environment: "east", scopePath: setup.path1 };
    const port = controller.forIdentity(token, { identity, namespace: "/alpha" });
    assert.throws(() => port.get(["flag"]), { code: "SCOPE_NOT_LOADED" });
    for (const selected of [{ environment: "west", scopePath: setup.path1 }, { environment: "east", scopePath: setup.path2 }]) assert.throws(() => controller.forIdentity(token, { identity: selected, namespace: "/alpha" }), { code: "FORBIDDEN" });
    for (const namespace of ["/", "/alph", "/beta"]) assert.throws(() => controller.forIdentity(token, { identity, namespace }), { code: "FORBIDDEN" });
    const narrowed = controller.forIdentity(token, { identity, namespace: "/alpha/cfg" });
    assert.equal(setup.first.loads + setup.second.loads, 0);
    await port.prepare(); assert.equal(port.get(["flag"]), "one");
    assert.deepEqual(narrowed.get(), { a: 1, b: 2, c: 3 });
    const split = principal(setup.input); split.grants[0].identity.scopePath = structuredClone(setup.path2);
    split.grants[0].layers = ["base"]; split.grants.push({ ...split.grants[0], layers: ["scope", "last"] });
    assert.throws(() => controller.forIdentity(controller.mint(split), { identity: split.grants[0].identity, namespace: "/alpha" }), { code: "FORBIDDEN" }); assert.equal(setup.second.loads, 0);
    const ordered = principal(setup.input); ordered.grants[0].identity.scopePath = [{ scopeId: "constructor", value: "toString" }, { scopeId: "area", value: "雪,:" }];
    const orderToken = controller.mint(ordered);
    assert.throws(() => controller.forIdentity(orderToken, { identity: { environment: "east", scopePath: [...ordered.grants[0].identity.scopePath].reverse() }, namespace: "/alpha" }), { code: "FORBIDDEN" });
  } finally { await root.dispose(); }
});

test("revocation/expiry during delayed preparation cannot publish, a new reader cannot switch queued identity authority", async () => {
  for (const expire of [false, true]) {
    let now = 0; const gate = deferred(), setup = scopeOptions({ firstGate: gate });
    const { root, controller } = await hosted(setup.input, { now: () => now });
    try {
      const claims = principal(setup.input, { expiresAt: 10 }); claims.grants.push({ ...claims.grants[0], identity: { environment: "east", scopePath: setup.path1 } });
      const token = controller.mint(claims);
      const selected = controller.forIdentity(token, { identity: claims.grants[1].identity, namespace: "/alpha" });
      const pending = selected.prepare(); const rejected = assert.rejects(pending, { code: "FORBIDDEN" });
      await Promise.resolve(); assert.equal(setup.first.loads, 1);
      if (expire) now = 10; else controller.revoke(token);
      const base = controller.forIdentity(controller.mint(principal(setup.input)), { identity: setup.input.identity, namespace: "/alpha" });
      gate.resolve(); await rejected;
      const replacement = principal(setup.input); replacement.grants[0].identity.scopePath = setup.path1;
      const port = controller.forIdentity(controller.mint(replacement), { identity: replacement.grants[0].identity, namespace: "/alpha" });
      assert.throws(() => port.get(["flag"]), { code: "SCOPE_NOT_LOADED" });
      assert.equal(base.get(["flag"]), "base");
      assert.equal(setup.first.writes + setup.first.removes + setup.first.flushes, 0);
    } finally { gate.resolve(); await root.dispose(); }
  }
});

test("detached persisted input owns metadata; conflicts and durable ceilings reject before IO", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "public" } });
  const input = options([provider]), registry = { initial: persisted(input.schemas) };
  const host = readonlyHost(input);
  await assert.rejects(createConfigurationService(input, { ...host, registry }), { code: "VALIDATION_ERROR" }); assert.equal(provider.loads, 0);
  const hostedInput = { ...input, schemas: [] }; const { root, controller } = await hosted(hostedInput, { registry });
  try {
    const reader = controller.forIdentity(controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
    registry.initial.environments = {};
    assert.equal(reader.get(["flag"]), "public");
    assert.equal(provider.loads, 1);
  } finally { await root.dispose(); }
  const initial = persisted([registration("west", "other", { type: "object", properties: { absent: { type: "string", "x-weaver": { maxOverrideLayer: "base" } } } })]);
  await assert.rejects(createConfigurationService(hostedInput, { ...host, registry: { initial } }), { code: "UNSUPPORTED_OPERATION" }); assert.equal(provider.loads, 1);
});

test("host preflight is own-data/native shape, missing AuthConfig and malformed ranks deny before hooks", async () => {
  const provider = new MemoryProvider("p", "base", {}), input = options([provider]); let getters = 0, hooks = 0;
  const base = { authConfig: authConfig(input), onAuthorityReady() { hooks++; }, hostAuthority: { authorizeReadSync() { hooks++; return "allowed"; }, async authorizeWrite() { hooks++; return "allowed"; } } };
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
    const reader = controller.forIdentity(controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
    assert.equal(reader.get(["flag"]), "public");
    assert.ok(hostAuthority.reads > 0); assert.equal(bindGetters, 0); assert.equal(Object.isFrozen(hostAuthority), false);
  } finally { await root.dispose(); }
});

test("controller callback failure fences pending work and cleans every owned hook once with sanitized primary error", async () => {
  const setup = scopeOptions(); const closed = []; let controller, pending;
  setup.input.providers[0].ownership = { kind: "owned", dispose() { closed.push("base"); throw Error("PRIVATE"); } };
  setup.input.providers[1].ownership = { kind: "owned", dispose() { closed.push("scope"); } };
  await assert.rejects(hosted(setup.input, { onAuthorityReady(value) {
    controller = value; const claims = principal(setup.input); claims.grants[0].identity.scopePath = setup.path1;
    pending = value.forIdentity(value.mint(claims), { identity: claims.grants[0].identity, namespace: "/alpha" }).prepare(); pending.catch(() => {});
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
        const token = controller.mint(principal(input));
        const reader = controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" });
        assert.equal(reader.get(["flag"]), "public"); assert.equal(reader.inspect(["flag"]).effective.value, "public");
        assert.equal((await controller.forMutations(token).apply(commands(input, { operation: "remove", path: "/alpha/flag" }))).error.code, "WRITE_UNAVAILABLE");
        controller.revoke(token); assert.throws(() => reader.get(["flag"]), { code: "FORBIDDEN" });
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
    const port = controller.forIdentity(token, { identity: selection, namespace: "/alpha" });
    selection.scopePath.reverse(); claims.grants[0].identity.scopePath[0].value = "changed";
    const base = controller.forIdentity(controller.mint(principal(setup.input)), { identity: setup.input.identity, namespace: "/alpha" });
    const initial = base.revision; await port.prepare();
    assert.equal(port.get(["flag"]), "two"); assert.equal(port.inspect(["flag"]).revision, port.revision);
    assert.deepEqual(port.selection.identity.scopePath, full); assert.equal(base.revision, initial);
    assert.equal(port.withScope(full).get(["flag"]), "two");
    assert.equal(setup.first.loads, 1); assert.equal(setup.second.loads, 1);
  } finally { await root.dispose(); }
});

test("unsupported session and partial operations cannot authorize inspection or preparation", async () => {
  const { root, controller, input } = await hosted();
  try {
    const session = principal(input, { session: { mode: "emergency-override", overrideReason: "host request" } });
    assert.throws(() => controller.forIdentity(controller.mint(session), { identity: input.identity, namespace: "/alpha" }), { code: "FORBIDDEN" });
    const claims = principal(input); claims.grants[0].operations = ["read"];
    const token = controller.mint(claims);
    const reader = controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" });
    assert.equal(reader.get(["flag"]), "public");
    assert.throws(() => reader.inspect(["flag"]), { code: "FORBIDDEN" });
    assert.throws(() => reader.get(["not-declared"]), { code: "SCHEMA_NOT_REGISTERED" });
    const writeOnly = principal(input); writeOnly.grants[0].operations = ["write"];
    const writeToken = controller.mint(writeOnly);
    assert.throws(() => controller.forIdentity(writeToken, { identity: input.identity, namespace: "/alpha" }), { code: "FORBIDDEN" });
    assert.equal((await controller.forMutations(writeToken).apply(commands(input, { operation: "remove", path: "/alpha/flag" }))).error.code, "WRITE_UNAVAILABLE");
    assert.throws(() => controller.replace(token, { principalId: "invalid" }), { code: "VALIDATION_ERROR" });
    assert.throws(() => reader.get(["flag"]), { code: "FORBIDDEN" });
  } finally { await root.dispose(); }
});

test("owned live metadata publication replaces current projections without an external reader", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "public" } }), input = options([provider]);
  const { root, controller } = await hosted(input);
  const token = controller.mint(principal(input));
  const reader = controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" });
  assert.equal(reader.get(["flag"]), "public");
  const schemas = controller.forSchemas(controller.mint(schemaClaims(input)));
  const request = structuredClone(input.schemas[0]);
  request.schema.properties.flag["x-weaver"] = { sensitive: true };
  assert.equal((await schemas.register(request)).success, true);
  try {
    assert.throws(() => reader.get(["flag"]), { code: "FORBIDDEN" });
    assert.deepEqual(reader.inspect(["flag"]).effective, { state: "redacted" });
    assert.equal(provider.loads, 1);
  } finally { await root.dispose(); }
});

test("disposal fences host ports and waits active preparation before all owned hooks", async () => {
  const gate = deferred(), setup = scopeOptions({ firstGate: gate }); let closed = 0;
  setup.input.providers[1].ownership = { kind: "owned", dispose() { closed++; } };
  const { root, controller } = await hosted(setup.input);
  const claims = principal(setup.input); claims.grants[0].identity.scopePath = setup.path1;
  const token = controller.mint(claims), mutations = controller.forMutations(token);
  const port = controller.forIdentity(token, { identity: claims.grants[0].identity, namespace: "/alpha" });
  const pending = port.prepare(), rejection = assert.rejects(pending, { code: "DISPOSED" });
  await Promise.resolve(); assert.equal(setup.first.loads, 1);
  const disposal = root.dispose(); assert.equal(closed, 0); assert.equal(root.dispose(), disposal);
  gate.resolve(); await rejection; assert.equal((await disposal).ok, true); assert.equal(closed, 1);
  assert.throws(() => port.get(["flag"]), { code: "DISPOSED" });
  assert.equal((await mutations.apply(commands(setup.input, { identity: claims.grants[0].identity, operation: "set", path: "/alpha/flag", value: "after", layer: "scope" }))).error.code, "DISPOSED");
});

test("audit/async-write ports without writer opt-in remain unavailable without effects", async () => {
  let audits = 0, writes = 0; const input = options([new MemoryProvider("p", "base", { alpha: { flag: "before" } })]);
  const { root, controller } = await hosted(input, {
    audit() { audits++; throw Error("must not execute"); },
    hostAuthority: { authorizeReadSync() { return "allowed"; }, async authorizeWrite() { writes++; return "allowed"; } },
  });
  try {
    const token = controller.mint(principal(input));
    const reader = controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" });
    const mutations = controller.forMutations(token);
    assert.equal((await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "after" }))).error.code, "WRITE_UNAVAILABLE");
    assert.equal((await mutations.apply(commands(input, { operation: "remove", path: "/alpha/flag" }))).error.code, "WRITE_UNAVAILABLE");
    assert.equal(reader.get(["flag"]), "before"); assert.equal(audits + writes, 0);
    assert.equal(input.providers[0].provider.flushes, 0);
  } finally { await root.dispose(); }
});

test("host callback reentrancy and asynchronous readiness are rejected without raw callback errors", async () => {
  let reader, reenter = false;
  const setup = await hosted(undefined, { hostAuthority: {
    authorizeReadSync() { if (reenter) reader.get(["flag"]); return "allowed"; }, async authorizeWrite() { return "allowed"; },
  } }); const root = setup.root;
  try {
    reader = setup.controller.forIdentity(setup.controller.mint(principal(setup.input)), { identity: setup.input.identity, namespace: "/alpha" }); reenter = true;
    assert.throws(() => reader.get(["flag"]), { code: "FORBIDDEN" });
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
    const host = { authConfig: config, onAuthorityReady() { callbacks++; }, hostAuthority: { authorizeReadSync() { callbacks++; return "allowed"; }, async authorizeWrite() { callbacks++; return "allowed"; } } };
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
  await assert.rejects(createConfigurationService(input, readonlyHost(input)), { code: "UNSUPPORTED_OPERATION" });
  assert.equal(provider.loads, 0);
});

async function disposedAuthorityFixture() {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "public" } }), input = options([provider]);
  const calls = { reads: 0, writes: 0, clock: 0, closed: 0 };
  let now = 0;
  input.providers[0].ownership = { kind: "owned", dispose() { calls.closed++; } };
  const { root, controller } = await hosted(input, {
    now() { calls.clock++; return now; },
    hostAuthority: { authorizeReadSync() { calls.reads++; return "allowed"; }, async authorizeWrite() { calls.writes++; return "allowed"; } },
  });
  const valid = controller.mint(principal(input)), revoked = controller.mint(principal(input));
  const expired = controller.mint(principal(input, { expiresAt: 5 }));
  const ports = [valid, revoked, expired].map((token) => controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" }));
  const mutations = [valid, revoked, expired].map((token) => controller.forMutations(token));
  await ports[0].prepare(); assert.equal(ports[0].get(["flag"]), "public");
  assert.ok(calls.reads > 0); assert.equal(provider.loads, 1);
  controller.revoke(revoked);
  const disposal = root.dispose(); assert.equal((await disposal).ok, true); now = 10;
  return { root, controller, input, provider, calls, ports, mutations, tokens: [valid, revoked, expired, {}], disposal };
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
    for (const read of [() => port.get(["flag"]), () => port.get(["missing"], { defaultValue: "fallback" }), () => port.get(["flag"], { layer: "base" }), () => port.get(), () => port.snapshot(), () => port.withScope([]), () => port.inspect(["flag"]), () => port.onChange(["flag"], () => {}), () => port.selection, () => port.revision]) assert.throws(read, { code: "DISPOSED" });
    assert.equal("set" in port, false); assert.equal("remove" in port, false);
  }
  for (const token of tokens) {
    assert.throws(() => controller.forMutations(token), { code: "DISPOSED" });
    for (const operation of [() => controller.revoke(token), () => controller.replace(token, principal(input)), () => controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" }), () => controller.forIdentity(token, { identity: {}, namespace: "invalid" })]) assert.throws(operation, { code: "DISPOSED" });
  }
  assert.throws(() => controller.mint({}), { code: "DISPOSED" });
  for (const read of [() => root.mode, () => root.degradedProviders]) assert.throws(read, { code: "DISPOSED" });
  for (const mutations of setup.mutations)
    for (const command of [{ operation: "set", path: "/alpha/flag", value: "changed" }, { operation: "remove", path: "/alpha/flag" }])
      assert.equal((await mutations.apply(commands(input, command))).error.code, "DISPOSED");
  for (const result of [await root.reloadProvider("p"), await root.flush()]) assert.equal(result.error.code, "DISPOSED");
  assert.equal(root.dispose(), disposal);
}

  test("fresh terminal authority calls fence the owned registry before callbacks", async () => {
    const setup = await disposedAuthorityFixture();
    const before = { ...setup.calls }, providerBefore = { loads: setup.provider.loads, writes: setup.provider.writes, removes: setup.provider.removes, flushes: setup.provider.flushes };
    await assertTerminalAuthority(setup);
    assert.deepEqual(setup.calls, before);
    assert.equal(setup.calls.closed, 1);
    assert.deepEqual({ loads: setup.provider.loads, writes: setup.provider.writes, removes: setup.provider.removes, flushes: setup.provider.flushes }, providerBefore);
  });
