import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { createConfigurationService } from "@weaver-conf/config-service";
import { createInMemoryStorageProvider, serverAuthorityOptionsSchema, startWeaverServer } from "../src/index.ts";
import { startWeaverServerInternal } from "../src/server.ts";
import { createJwtValidator } from "../src/auth/jwt-validator.ts";
import { createAuthMiddleware } from "../src/auth/auth-middleware.ts";
import { withAuthorityRequest } from "../src/transport/authority-rest-principal.ts";
import { selectAuthorityRequest } from "../src/transport/authority-rest-request.ts";
import { deferred, effects, filesystemHost, http, jwt, testSecret } from "./fixtures/authority-host.mjs";

const noLegacy = () => assert.fail("legacy bootstrap was constructed");

test("authority production ledger respects source/function/nesting/type limits", async () => {
  const paths = ["server-authority.ts", "server-authority-options.ts", "server-authority-lifecycle.ts", "core/authority-registry-bootstrap.ts",
    ...["adapter", "routes", "contracts", "principal", "request", "response"].map((name) => `transport/authority-rest-${name}.ts`)];
  for (const path of paths) {
    const text = await readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
    assert.ok(text.trimEnd().split("\n").length <= 400, path);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const line = (position) => source.getLineAndCharacterOfPosition(position).line;
    const visit = (node, depth = 0) => {
      assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, `${path}: explicit any`);
      assert.equal(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node), false, `${path}: type assertion`);
      assert.equal(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false, false, `${path}: default export`);
      if (ts.isFunctionLike(node) && node.body) {
        assert.ok(line(node.end) - line(node.getStart(source)) + 1 < 50, `${path}:${line(node.getStart(source)) + 1} function >=50 lines`);
        depth = 0;
      }
      if (ts.isIfStatement(node) || ts.isIterationStatement(node, false) || ts.isTryStatement(node) || ts.isSwitchStatement(node)) depth++;
      assert.ok(depth <= 3, `${path}:${line(node.getStart(source)) + 1} nesting >3`);
      ts.forEachChild(node, (child) => visit(child, depth));
    };
    visit(source);
  }
});

test("legacy public startup also rejects actual occupied loopback port", async () => {
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  let unexpected;
  try {
    const provider = createInMemoryStorageProvider({ id: "platform", layer: "platform" });
    await assert.rejects(startWeaverServer({ port: occupied.address().port, providers: [provider] })
      .then((server) => { unexpected = server; }), { code: "EADDRINUSE" });
  } finally {
    await unexpected?.close();
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test("strict authority presence never falls through to legacy, invalid options precede IO", async () => {
  const fixture = await filesystemHost();
  try {
    const options = fixture.options;
    const missing = (field) => { const authority = { ...options.authority }; delete authority[field]; return { ...options, authority }; };
    const invalid = [null, false, 0, "", {}].map((authority) => ({ ...options, authority }));
    invalid.push(...["authConfig", "hostAuthority", "mapPrincipal", "writers"].map(missing));
    invalid.push({ ...options, jwtSecret: "" }, { ...options, environment: "wrong" },
      ...["providers", "adminRoles", "repoUrl", "gitToken", "mongoUri", "auditService", "unknown"].map((key) => ({ ...options, [key]: undefined })),
      { ...options, authority: { ...options.authority, configuration: { ...options.authority.configuration, schemas: [{}] } } },
      { ...options, authority: { ...options.authority, mapPrincipal: undefined } },
      { get authority() { assert.fail("getter was invoked"); } },
      Object.create({ authority: options.authority }));
    for (const input of invalid) await assert.rejects(startWeaverServerInternal(input, noLegacy), { code: "VALIDATION_ERROR" });
    for (const { calls } of Object.values(fixture.controls)) assert.deepEqual(calls, { load: 0, write: 0, remove: 0, flush: 0, close: 0 });
    assert.equal(serverAuthorityOptionsSchema.safeParse(options.authority).success, true);
    const server = await startWeaverServerInternal(options, noLegacy);
    assert.equal((await http(server, "/v1/config/example/name")).status, 200);
    await server.close();
  } finally { await fixture.cleanup(); }
});

test("authority env selection ignores legacy bootstrap env and missing JWT rejects before IO", async () => {
  const fixture = await filesystemHost({ environment: "production" });
  const keys = ["WEAVER_JWT_SECRET", "WEAVER_ENVIRONMENT", "WEAVER_MONGO_URI", "WEAVER_CONFIG_REPO"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let server;
  try {
    delete process.env.WEAVER_JWT_SECRET;
    const options = { ...fixture.options }; delete options.jwtSecret;
    await assert.rejects(startWeaverServerInternal(options, noLegacy), { code: "VALIDATION_ERROR" });
    for (const { calls } of Object.values(fixture.controls)) assert.equal(calls.load, 0);
    process.env.WEAVER_JWT_SECRET = testSecret;
    process.env.WEAVER_ENVIRONMENT = "wrong-environment";
    process.env.WEAVER_MONGO_URI = "not-a-valid-uri";
    process.env.WEAVER_CONFIG_REPO = "not-a-repository";
    server = await startWeaverServerInternal(options, noLegacy);
    assert.equal((await http(server, "/v1/config/example/name?env=production")).status, 200);
    assert.equal((await http(server, "/v1/config/example/name?env=wrong-environment")).status, 403);
  } finally {
    await server?.close(); await fixture.cleanup();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  }
});

test("native option schemas reject accessor callbacks without invocation and retain captured mapper", async () => {
  const fixture = await filesystemHost();
  try {
    let reads = 0;
    for (const key of ["mapPrincipal", "hostAuthority", "authConfig", "configuration", "registry"]) {
      const authority = { ...fixture.authority };
      Object.defineProperty(authority, key, { enumerable: true, get() { reads++; throw new Error("SECRET"); } });
      assert.equal(serverAuthorityOptionsSchema.safeParse(authority).success, false);
    }
    assert.equal(reads, 0);
    Object.defineProperty(fixture.authority.mapPrincipal, "bind", { get() { assert.fail("borrower bind getter"); } });
    const server = await startWeaverServer(fixture.options);
    try {
      fixture.authority.mapPrincipal = () => assert.fail("late mapper replacement");
      fixture.authority.hostAuthority.authorizeReadSync = () => assert.fail("late authority replacement");
      assert.equal((await http(server, "/v1/config/example/name")).status, 200);
      assert.equal((await http(server, "/v1/config/example-suffix/name")).status, 403);
    } finally { await server.close(); }
  } finally { await fixture.cleanup(); }
});

test("missing registry startup and occupied listener close all owned hooks despite failures", async () => {
  for (const occupied of [false, true]) {
    const fixture = await filesystemHost(); const socket = createServer();
    let unexpectedServer;
    try {
      fixture.authority.configuration.providers[1].ownership = { kind: "borrowed" };
      const first = fixture.authority.configuration.providers[0];
      const dispose = first.ownership.dispose;
      first.ownership.dispose = () => { dispose(); throw new Error("SECRET cleanup"); };
      if (occupied) {
        await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
        fixture.options.port = socket.address().port;
      } else await first.provider.remove("_weaver.registry.schemas");
      await assert.rejects(startWeaverServer(fixture.options).then((server) => { unexpectedServer = server; }), (error) => {
        assert.doesNotMatch(error.message, /SECRET|EADDRINUSE|127\.0/);
        assert.equal(error.code, occupied ? "INTERNAL_ERROR" : "SERVER_DEGRADED");
        return true;
      });
      assert.equal(fixture.controls.base.calls.close, 1);
      assert.equal(fixture.controls.a.calls.close, 0);
      assert.equal(fixture.controls.b.calls.close, 1);
      assert.equal(fixture.controls.late.calls.close, 1);
    } finally {
      await unexpectedServer?.close().catch(() => {});
      if (socket.listening) await new Promise((resolve) => socket.close(resolve));
      await fixture.cleanup();
    }
  }
});

test("invalid durable registry and root factory failure settle transferred ownership; empty registry stays undeclared", async () => {
  for (const kind of ["invalid", "factory", "empty"]) {
    const fixture = await filesystemHost(); let server;
    try {
      const base = fixture.authority.configuration.providers[0].provider;
      if (kind === "invalid") await base.write("_weaver.registry.schemas", { version: 99, environments: {} });
      if (kind === "empty") await base.write("_weaver.registry.schemas", { version: 2, environments: {} });
      if (kind === "factory") fixture.authority.writers[0].providerId = "missing";
      const before = effects(fixture);
      if (kind !== "empty") {
        await assert.rejects(startWeaverServer(fixture.options), { code: "VALIDATION_ERROR" });
        for (const { calls } of Object.values(fixture.controls)) assert.equal(calls.close, 1);
      } else {
        server = await startWeaverServer(fixture.options);
        assert.ok((await http(server, "/v1/config/example/name")).status >= 400);
        assert.ok((await http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: "no-schema" } })).status >= 400);
      }
      assert.deepEqual(effects(fixture), before);
    } finally { await server?.close(); await fixture.cleanup(); }
  }
});

test("memoized close waits actual dispatched flush even after network abort, all owned hooks once", async () => {
  const fixture = await filesystemHost(); const entered = deferred(), release = deferred();
  fixture.controls.late.flush = async () => { entered.resolve(); await release.promise; };
  const server = await startWeaverServer(fixture.options);
  try {
    const abort = new AbortController();
    const request = http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: "durable" }, signal: abort.signal }).catch(() => undefined);
    await entered.promise; abort.abort(); await request;
    let closed = false;
    const closing = server.close(); assert.equal(server.close(), closing);
    void closing.then(() => { closed = true; });
    assert.equal(server.isReady, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, false);
    for (const { calls } of Object.values(fixture.controls)) assert.equal(calls.close, 0);
    release.resolve(); await closing;
    for (const { calls } of Object.values(fixture.controls)) assert.equal(calls.close, 1);
    assert.equal((await fixture.authority.configuration.providers.at(-1).provider.load()).entries.example.name, "durable");
    await assert.rejects(http(server, "/v1/config/example/name"));
    assert.equal(server.close(), closing);
  } finally { release.resolve(); await server.close(); await fixture.cleanup(); }
});

test("close failure is sanitized and memoized after every hook was attempted", async () => {
  const fixture = await filesystemHost();
  const first = fixture.authority.configuration.providers[0]; const original = first.ownership.dispose;
  first.ownership.dispose = () => { original(); throw new Error("SECRET"); };
  const server = await startWeaverServer(fixture.options);
  try {
    const closing = server.close(); assert.equal(server.close(), closing);
    await assert.rejects(closing, { code: "INTERNAL_ERROR", message: "Authority cleanup failed" });
    for (const { calls } of Object.values(fixture.controls)) assert.equal(calls.close, 1);
  } finally { await fixture.cleanup(); }
});

test("mapped class authority preserves receiver and malformed/async principal fails closed", async () => {
  const fixture = await filesystemHost();
  class HostAuthority {
    read = 0; write = 0;
    authorizeReadSync() { this.read++; return "allowed"; }
    async authorizeWrite() { this.write++; return "allowed"; }
  }
  const host = new HostAuthority(); fixture.authority.hostAuthority = host;
  const map = fixture.authority.mapPrincipal;
  fixture.authority.mapPrincipal = function (context, identity) {
    assert.equal(this, fixture.authority); assert.ok(Object.isFrozen(identity));
    return map(context, identity);
  };
  let server = await startWeaverServer(fixture.options);
  try {
    assert.equal((await http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: "yes" } })).status, 200);
    assert.ok(host.read > 0); assert.equal(host.write, 1);
    await server.close();
    for (const mapping of [() => null, () => { throw new Error("SECRET"); }, () => Promise.reject(new Error("SECRET")), () => ({ get grants() { assert.fail("getter"); } })]) {
      fixture.authority.mapPrincipal = mapping;
      server = await startWeaverServer(fixture.options); const before = effects(fixture);
      const response = await http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: "no" } });
      assert.equal(response.status, 403); assert.doesNotMatch(JSON.stringify(response.body), /SECRET/);
      assert.deepEqual(effects(fixture), before); await server.close();
    }
  } finally { await server.close(); await fixture.cleanup(); }
});

test("signed expiry captured before mapping cannot be extended through delayed authorization", async () => {
  const fixture = await filesystemHost(); const entered = deferred(), release = deferred();
  let now = Date.now(); const exp = Math.floor(now / 1000) + 300;
  fixture.authority.now = () => now;
  const map = fixture.authority.mapPrincipal;
  fixture.authority.mapPrincipal = (context, identity) => {
    context.identity.claims.exp = exp + 10000;
    return { ...map(context, identity), expiresAt: (exp + 10000) * 1000 };
  };
  fixture.authority.hostAuthority.authorizeWrite = async () => { entered.resolve(); await release.promise; return "allowed"; };
  const server = await startWeaverServer(fixture.options);
  try {
    const before = effects(fixture);
    const response = http(server, "/v1/config/example/name?layer=late", { method: "PUT", token: jwt({ exp }), body: { value: "expired" } });
    await entered.promise; now = (exp + 1) * 1000; release.resolve();
    assert.equal((await response).status, 403); assert.deepEqual(effects(fixture), before);
  } finally { release.resolve(); await server.close(); await fixture.cleanup(); }
});

test("concurrent principals use separate namespaces and tokens without root rebinding", async () => {
  const fixture = await filesystemHost(); const entered = deferred(), release = deferred(); const seen = [];
  fixture.authority.hostAuthority.authorizeWrite = async (principal) => {
    seen.push(principal.principalId);
    if (principal.principalId === "alice") { entered.resolve(); await release.promise; }
    return "allowed";
  };
  const server = await startWeaverServer(fixture.options);
  try {
    const first = http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: "alice" } });
    await entered.promise;
    const second = http(server, "/v1/config/other/name?layer=late", { method: "PUT", token: jwt({ sub: "bob" }), body: { value: "bob" } });
    assert.equal((await http(server, "/v1/config/example/name", { token: jwt({ sub: "bob" }) })).status, 403);
    release.resolve(); assert.equal((await first).status, 200); assert.equal((await second).status, 200);
    assert.deepEqual(seen, ["alice", "bob"]);
    assert.equal((await http(server, "/v1/config/example/name")).body.data.value, "alice");
    assert.equal((await http(server, "/v1/config/other/name", { token: jwt({ sub: "bob" }) })).body.data.value, "bob");
  } finally { release.resolve(); await server.close(); await fixture.cleanup(); }
});

test("finally revokes real request port after verified JWT operation, including failed operation", async () => {
  const fixture = await filesystemHost(); let controller;
  const { configuration, registry: _, mapPrincipal: __, ...host } = fixture.authority;
  const root = await createConfigurationService(configuration, { ...host, registry: fixture.registry.reader, onAuthorityReady(value) { controller = value; } });
  try {
    const auth = createAuthMiddleware({ jwtValidator: createJwtValidator({ publicKeyOrSecret: testSecret }), adminRoles: [] });
    const context = await auth.authenticate(jwt());
    const selected = selectAuthorityRequest("GET", { params: { keyPath: "example/name" }, query: {}, headers: {} }, configuration.identity);
    for (const fail of [false, true]) {
      let captured;
      const operation = withAuthorityRequest(fixture.authority, controller, context, selected, () => {}, (port) => {
        captured = port;
        if (fail) throw new Error("operation");
        return port.get(selected.path);
      });
      if (fail) await assert.rejects(operation, /operation/); else assert.equal(await operation, "base");
      assert.throws(() => captured.get(selected.path), { code: "FORBIDDEN" });
    }
  } finally { await root.dispose(); await fixture.cleanup(); }
});
