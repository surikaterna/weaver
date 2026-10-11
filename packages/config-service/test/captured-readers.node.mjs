import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createConfigurationService } from "../dist/index.js";
import { hosted, principal } from "./fixtures/authority.mjs";
import { MemoryProvider, deferred, options, scopeOptions } from "./fixtures/memory.mjs";
import { withConsumer } from "./fixtures/packed-consumer.mjs";
import { strictDeclarations } from "./fixtures/packed-declarations.mjs";
import { filesystemProof } from "./fixtures/packed-filesystem.mjs";
import { browserProof } from "./fixtures/packed-browser.mjs";
import { schemaClaims } from "./fixtures/live-registry.mjs";
import { writable, commands } from "./fixtures/writable-memory.mjs";

function issue(setup, claims = principal(setup.input), namespace = "/alpha") {
  const token = setup.controller.mint(claims);
  const reader = setup.controller.forIdentity(token, { identity: setup.input.identity, namespace });
  return { token, reader };
}

test("bounded shared schema/value DAG checks distinct logical addresses without sharing approval", async () => {
  const depth = 12;
  let schema = { type: "string" }, value = "shared-leaf";
  for (let level = 0; level < depth; level++) {
    schema = { type: "object", properties: { left: schema, right: schema } };
    value = { left: value, right: value };
  }
  const provider = new MemoryProvider("p", "base", { alpha: value });
  const input = options([provider]); input.schemas = [{ ...input.schemas[0], schema }];
  const denied = ["alpha", ...Array(depth).fill("left")], seen = new Set();
  let restrict = true;
  const setup = await hosted(input, { hostAuthority: {
    authorizeReadSync(_principal, request) {
      seen.add(request.path);
      return restrict && request.path === `/${denied.join("/")}` ? "denied" : "allowed";
    },
    async authorizeWrite() { return "denied"; },
  } });
  try {
    const { reader } = issue(setup), snapshot = reader.snapshot();
    assert.equal(snapshot.value.state, "value");
    let branch = snapshot.value.value;
    for (let level = 1; level < depth; level++) branch = branch.left;
    assert.deepEqual(branch, { right: "shared-leaf" });
    assert.equal(seen.size, 2 ** (depth + 1) - 1);
    assert.throws(() => reader.get(denied.slice(1)), { code: "FORBIDDEN" });
    assert.equal(reader.get([...Array(depth - 1).fill("left"), "right"]), "shared-leaf");
    restrict = false;
    assert.equal(reader.get(denied.slice(1)), "shared-leaf");
    assert.equal(provider.loads, 1);
    assert.deepEqual(branch, { right: "shared-leaf" });
  } finally { await setup.root.dispose(); }
});

test("root owns only lifecycle; reader is captured, detached and has one relative dialect", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "yes", "literal.dot": "dot", "雪": "unicode" } });
  const setup = await hosted(options([provider]));
  try {
    const { reader } = issue(setup);
    assert.deepEqual(Object.keys(setup.root).sort(), ["acknowledgeRestart", "degradedProviders", "dispose", "flush", "mode", "reloadProvider", "restartState"]);
    assert.equal(setup.controller.bindRoot, undefined);
    assert.deepEqual(Object.keys(reader).sort(), ["dispose", "forView", "get", "inspect", "onChange", "prepare", "revision", "selection", "snapshot", "validate", "withScope"]);
    assert.deepEqual(reader.get(), { flag: "yes", "literal.dot": "dot", "雪": "unicode" });
    assert.equal(reader.get(["literal.dot"]), "dot");
    assert.equal(reader.get(["雪"]), "unicode");
    assert.throws(() => reader.get("/alpha/flag"), { code: "VALIDATION_ERROR" });
    const snapshot = reader.snapshot(["flag"]);
    assert.deepEqual(snapshot.value, { state: "value", value: "yes" });
    assert.equal(snapshot.revision, reader.inspect(["flag"]).revision);
    assert.equal(snapshot.selection.namespace, "/alpha");
    assert.equal(provider.loads, 1);
    assert.equal(reader.get(["missing"], { defaultValue: "fallback" }), "fallback");
    assert.throws(() => reader.get(["undeclared"], { defaultValue: "no" }), { code: "SCHEMA_NOT_REGISTERED" });
    assert.equal(reader.get(["flag"], { layer: "base" }), "yes");
    assert.throws(() => reader.get(["flag"], { layer: "other" }), { code: "FORBIDDEN" });
  } finally { await setup.root.dispose(); }
});

test("scope selection replaces and freezes the tuple; cold selection has no IO", async () => {
  const scoped = scopeOptions();
  const setup = await hosted(scoped.input);
  const claims = principal(setup.input);
  claims.grants.push(...[scoped.path1, scoped.path2].map((scopePath) => ({ ...claims.grants[0], identity: { environment: "east", scopePath } })));
  try {
    const { reader } = issue(setup, claims);
    const selected = reader.withScope(scoped.path1);
    const replaced = selected.withScope(scoped.path2);
    scoped.path1[0].value = "changed";
    assert.equal(selected.selection.identity.scopePath[0].value, "one,:é");
    assert.equal(reader.selection.identity.scopePath.length, 0);
    assert.equal(replaced.selection.identity.scopePath.length, 1);
    assert.equal(scoped.first.loads, 0);
    assert.equal(scoped.second.loads, 0);
    assert.throws(() => selected.get(["flag"]), { code: "SCOPE_NOT_LOADED" });
    await Promise.all([selected.prepare(), replaced.prepare()]);
    assert.equal(selected.get(["flag"]), "one");
    assert.equal(replaced.get(["flag"]), "two");
    assert.deepEqual(selected.get(["cfg"]), { a: 1, b: 2, c: 3 });
    selected.dispose();
    assert.throws(() => selected.get(["flag"]), { code: "DISPOSED" });
    assert.equal(reader.get(["flag"]), "base");
    assert.equal(replaced.get(["flag"]), "two");
  } finally { await setup.root.dispose(); }
});

test("revocation and disposal fence all payload and derivation methods", async () => {
  let clocks = 0;
  const setup = await hosted(undefined, { now: () => { clocks++; return 10; } });
  const { reader, token } = issue(setup);
  const derived = reader.withScope([]);
  const unsubscribe = reader.onChange(["flag"], () => assert.fail("No publisher in .6"));
  setup.controller.revoke(token);
  for (const operation of [() => reader.get(["flag"]), () => reader.snapshot(["flag"]), () => reader.inspect(["flag"]), () => reader.validate(), () => reader.withScope([]), () => derived.get(["flag"])])
    assert.throws(operation, { code: "FORBIDDEN" });
  await assert.rejects(reader.prepare(), { code: "FORBIDDEN" });
  reader.dispose(); reader.dispose(); unsubscribe(); unsubscribe();
  const before = clocks;
  assert.throws(() => reader.get(["flag"]), { code: "DISPOSED" });
  assert.equal(clocks, before);
  assert.equal(setup.root.mode, "live");
  await setup.root.dispose();
  assert.throws(() => derived.get(["flag"]), { code: "DISPOSED" });
  assert.equal(clocks, before);
});

test("explicit root grant projects registered data, omitting internal instance storage", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "yes", instances: { private: { flag: "hidden" } } }, beta: { flag: "other" }, unknown: "hidden" });
  const setup = await hosted(options([provider]));
  const claims = principal(setup.input);
  claims.grants[0] = { ...claims.grants[0], namespace: "/", operations: ["read", "inspect"] };
  try {
    const { reader } = issue(setup, claims, "/");
    assert.deepEqual(reader.snapshot().value, { state: "value", value: { alpha: { flag: "yes" }, beta: { flag: "other" } } });
    assert.throws(() => reader.get(["alpha", "instances", "private"]), { code: "FORBIDDEN" });
    assert.throws(() => reader.forView("private"), { code: "FORBIDDEN" });
    const baseToken = setup.controller.mint(principal(setup.input));
    assert.throws(() => setup.controller.forIdentity(baseToken, { identity: setup.input.identity, namespace: "/" }), { code: "FORBIDDEN" });
  } finally { await setup.root.dispose(); }
});

test("factory requires explicit host authority before provider IO", async () => {
  const provider = new MemoryProvider("p", "base", { alpha: { flag: "yes" } });
  await assert.rejects(createConfigurationService(options([provider])), { code: "VALIDATION_ERROR" });
  assert.equal(provider.loads, 0);
});

test("shared cold hydration checks each waiter after await and revoked first waiter cannot poison a valid second", async () => {
  const gate = deferred();
  const scoped = scopeOptions({ firstGate: gate });
  const setup = await hosted(scoped.input);
  const claims = principal(setup.input);
  claims.grants.push({ ...claims.grants[0], identity: { environment: "east", scopePath: scoped.path1 } });
  const first = issue(setup, claims), second = issue(setup, claims);
  const revoked = first.reader.withScope(scoped.path1), valid = second.reader.withScope(scoped.path1);
  try {
    const waiting = Promise.allSettled([revoked.prepare(), valid.prepare()]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scoped.first.loads, 1);
    setup.controller.revoke(first.token);
    gate.resolve();
    const results = await waiting;
    assert.equal(results[0].status, "rejected");
    assert.equal(results[0].reason.code, "FORBIDDEN");
    assert.equal(results[1].status, "fulfilled");
    assert.equal(valid.get(["flag"]), "one");
    assert.throws(() => revoked.snapshot(), { code: "FORBIDDEN" });
    assert.equal(scoped.first.loads, 1);
  } finally { gate.resolve(); await setup.root.dispose(); }
});

test("caller accessor rejection, selector denial and foreign capabilities do not warm providers", async () => {
  const scoped = scopeOptions();
  const setup = await hosted(scoped.input), other = await hosted(scoped.input);
  let gets = 0;
  try {
    const { token, reader } = issue(setup);
    assert.throws(() => reader.withScope(scoped.path1), { code: "FORBIDDEN" });
    assert.throws(() => setup.controller.forIdentity(other.controller.mint(principal(other.input)), { identity: setup.input.identity, namespace: "/alpha" }), { code: "FORBIDDEN" });
    assert.throws(() => setup.controller.forIdentity({}, { identity: setup.input.identity, namespace: "/alpha" }), { code: "FORBIDDEN" });
    const bad = { identity: setup.input.identity, get namespace() { gets++; return "/alpha"; } };
    assert.throws(() => setup.controller.forIdentity(token, bad), { code: "FORBIDDEN" });
    const segment = []; Object.defineProperty(segment, "0", { enumerable: true, get() { gets++; return "flag"; } });
    assert.throws(() => reader.get(segment), { code: "VALIDATION_ERROR" });
    assert.throws(() => reader.get(["flag"], { get layer() { gets++; return "base"; } }), { code: "VALIDATION_ERROR" });
    assert.equal(gets, 0);
    assert.equal(scoped.first.loads + scoped.second.loads, 0);
  } finally { await setup.root.dispose(); await other.root.dispose(); }
});

test("expiry or root disposal inside trusted read callbacks releases no payload", async () => {
  let time = 0, expire = false;
  const setup = await hosted(undefined, {
    now: () => time,
    hostAuthority: { authorizeReadSync() { if (expire) time = 10; return "allowed"; }, authorizeWrite: async () => "denied" },
  });
  try {
    const { reader } = issue(setup, principal(setup.input, { expiresAt: 10 }));
    assert.equal(reader.get(["flag"]), "public");
    expire = true;
    assert.throws(() => reader.snapshot(["flag"]), { code: "FORBIDDEN" });
    assert.throws(() => reader.get(["missing"], { defaultValue: "must not escape" }), { code: "FORBIDDEN" });
  } finally { await setup.root.dispose(); }
  let close = false, root;
  const second = await hosted(undefined, { hostAuthority: {
    authorizeReadSync() { if (close) void root.dispose(); return "allowed"; }, authorizeWrite: async () => "denied",
  } });
  root = second.root;
  const { reader } = issue(second);
  close = true;
  assert.throws(() => reader.snapshot(["flag"]), { code: "DISPOSED" });
  await root.dispose();
});

test("failed initialization invalidates escaped readers and closes only host-owned resources", async () => {
  const input = options([new MemoryProvider("p", "base", { alpha: { flag: "yes" } })]);
  let escaped, closed = 0;
  input.providers[0].ownership = { kind: "owned", dispose() { closed++; } };
  await assert.rejects(hosted(input, { onAuthorityReady(controller) {
    escaped = controller.forIdentity(controller.mint(principal(input)), { identity: input.identity, namespace: "/alpha" });
    throw new Error("host initialization failed");
  } }), { code: "VALIDATION_ERROR" });
  assert.equal(closed, 1);
  assert.throws(() => escaped.get(["flag"]), { code: "DISPOSED" });
});

test("installed ESM/CJS captured readers and strict NodeNext/Bundler contracts", async () => {
  await withConsumer(async (directory) => {
    const require = createRequire(join(directory, "package.json"));
    for (const cjs of [false, true]) {
      const service = cjs ? require("@weaver-conf/config-service") : await import(pathToFileURL(require.resolve("@weaver-conf/config-service").replace(/\.cjs$/, ".js")));
      const setup = await hosted(undefined, {}, service.createConfigurationService);
      try {
        const { reader, token } = issue(setup);
        assert.equal(reader.snapshot(["flag"]).value.value, "public");
        assert.equal(reader.inspect(["flag"]).effective.value, "public");
        const derived = reader.withScope([]);
        await derived.prepare();
        reader.dispose();
        assert.throws(() => reader.get(["flag"]), { code: "DISPOSED" });
        assert.equal(derived.get(["flag"]), "public");
        setup.controller.revoke(token);
        assert.throws(() => derived.get(["flag"]), { code: "FORBIDDEN" });
        assert.equal(setup.root.get, undefined);
        assert.equal(setup.controller.bindRoot, undefined);
      } finally { await setup.root.dispose(); }
    }
    await strictDeclarations(directory);
    await filesystemProof(directory);
    await browserProof(directory);
  });
});

test("captured snapshots advance with the existing mutation publication and never share caller-mutable values", async () => {
  const setup = await writable();
  let notifications = 0;
  const release = setup.reader.onChange(["flag"], () => { notifications++; });
  try {
    const before = setup.reader.snapshot(["flag"]);
    const result = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/flag", value: "after" }));
    assert.equal(result.success, true);
    const after = setup.reader.snapshot(["flag"]);
    assert.equal(before.value.value, "before");
    assert.equal(after.value.value, "after");
    assert.notEqual(after.revision, before.revision);
    assert.equal(after.revision, result.revisions[0].revision);
    assert.equal(after.revision, setup.reader.inspect(["flag"]).revision);
    const object = setup.reader.get(["cfg"]);
    assert.throws(() => { object.a = 99; }, TypeError);
    assert.equal(setup.reader.get(["cfg", "a"]), 1);
    await Promise.resolve();
    assert.equal(notifications, 1, "one queued notification follows the committed publication");
  } finally { release(); await setup.root.dispose(); }
});

test("metadata publication changes existing reader disclosure and schema permissions do not issue read handles", async () => {
  const setup = await hosted();
  const { reader } = issue(setup);
  const token = setup.controller.mint(schemaClaims(setup.input));
  try {
    assert.throws(() => setup.controller.forIdentity(token, { identity: setup.input.identity, namespace: "/alpha" }), { code: "FORBIDDEN" });
    assert.equal(reader.get(["flag"]), "public");
    const request = structuredClone(setup.input.schemas[0]);
    request.schema.properties.flag["x-weaver"] = { sensitive: true };
    assert.equal((await setup.controller.forSchemas(token).register(request)).success, true);
    for (const read of [() => reader.get(["flag"]), () => reader.get(["flag"], { defaultValue: "no" }), () => reader.get(["flag"], { layer: "base" }), () => reader.snapshot(["flag"])])
      assert.throws(read, { code: "FORBIDDEN" });
    assert.equal(reader.get().flag, undefined);
    assert.equal(setup.input.providers[0].provider.loads, 1);
  } finally { await setup.root.dispose(); }
});
