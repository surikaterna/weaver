import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createConfigurationService } from "@weaver-conf/config-service";
import { createRegistryAdapter } from "@weaver-conf/config-registry/internal/server-adapter";
import { serializeRegistry } from "@weaver-conf/config-registry/persistence";
import { startWeaverServer } from "../src/index.ts";
import { deferred, effects, filesystemHost, http, jwt } from "./fixtures/authority-host.mjs";

function rejected(response, status, code, outcome) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
  assert.equal(response.body.meta.revision, "");
  assert.equal(response.headers.get("etag"), null);
  if (outcome) {
    assert.equal(response.body.data.outcome, outcome);
    assert.deepEqual(response.body.data.error, response.body.error);
    assert.equal(response.body.data.revisions, undefined);
  }
}
function success(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.headers.get("etag"), `"${response.body.meta.revision}"`);
  return response.body.data;
}
function semanticInspection(inspection) {
  const { revision, ...semantic } = inspection;
  assert.equal(typeof revision, "string"); return semantic;
}
async function directPort(fixture) {
  let controller;
  const { configuration, registry: _, mapPrincipal: __, ...host } = fixture.authority;
  const root = await createConfigurationService(configuration, { ...host, registry: { initial: fixture.registry.serialized, storage: { kind: "provider", providerId: fixture.authority.registry.providerId } },
    onAuthorityReady(value) { controller = value; } });
  const principal = fixture.authority.mapPrincipal({ identity: { userId: "alice" } });
  const token = controller.mint(principal);
  const port = controller.forIdentity(token, { identity: configuration.identity, namespace: "/example" });
  await port.prepare();
  return { root, port, mutations: controller.forMutations(token), selection: { identity: configuration.identity, namespace: "/example", layer: "late" } };
}

async function projectedTupleFixture() {
  const fixture = await filesystemHost();
  const tuple = { type: "array", items: [
    { type: "string" }, { type: "string", "x-weaver": { sensitive: true } }, { type: "string" },
  ] };
  const adapter = createRegistryAdapter({ defaultEnvironment: "dev" });
  const prepared = adapter.prepare({ serviceId: "example", environment: "dev", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [],
    schema: { type: "object", properties: { name: { type: "string" }, count: { type: "number" }, blocked: { type: "string" },
      list: tuple, nested: { type: "object", properties: { list: tuple } }, missing: { type: "string" }, literalNull: { type: "null" },
    } } });
  assert.equal(prepared.result.success, true); prepared.publish();
  fixture.registry.serialized = serializeRegistry(adapter.snapshot());
  const base = fixture.authority.configuration.providers[0].provider;
  await base.write("_weaver.registry.schemas", fixture.registry.serialized);
  await base.write("example.list", ["first", "PRIVATE-ARRAY-CREDENTIAL", "third"]);
  await base.write("example.nested", { list: ["first", "PRIVATE-NESTED-CREDENTIAL", "third"] });
  await base.write("example.literalNull", null);
  return fixture;
}

test("real JWT HTTP redacts whole restricted arrays without holes, null placeholders or weakened mutation input", async () => {
  const fixture = await projectedTupleFixture(); let server, root, controller;
  try {
    server = await startWeaverServer(fixture.options);
    const { configuration, registry: _, mapPrincipal: __, ...host } = fixture.authority;
    root = await createConfigurationService({ ...configuration, providers: configuration.providers.map((binding) => ({ ...binding, ownership: { kind: "borrowed" } })) }, {
      ...host, registry: { initial: fixture.registry.serialized }, onAuthorityReady(value) { controller = value; },
    });
    const token = controller.mint(fixture.authority.mapPrincipal({ identity: { userId: "alice" } }));
    const query = controller.forIdentity(token, { identity: configuration.identity, namespace: "/example" });
    assert.throws(() => query.get(["list"]), { code: "FORBIDDEN" });
    assert.deepEqual(query.inspect(["list"]).effective, { state: "redacted" });
    const value = ["first", , "third"];
    const before = effects(fixture);
    const result = await controller.forMutations(token).apply([{ identity: configuration.identity, namespace: "/example", layer: "base", operation: "set", path: "/example/list", value }]);
    assert.equal(result.error.code, "VALIDATION_ERROR"); assert.deepEqual(effects(fixture), before);
    const listResponse = await http(server, "/v1/config/example/list");
    rejected(listResponse, 403, "FORBIDDEN");
    const nestedResponse = await http(server, "/v1/config/example/nested"), nested = success(nestedResponse);
    assert.deepEqual(nested.value, {});
    const inspectionResponse = await http(server, "/v1/config/example/list?inspect"), inspection = success(inspectionResponse);
    assert.deepEqual(inspection.effective, { state: "redacted" });
    assert.doesNotMatch(JSON.stringify({ list: listResponse.body, nested: nestedResponse.body, inspection: inspectionResponse.body, result }), /PRIVATE|CREDENTIAL|cause/);
    assert.equal(Object.hasOwn(success(await http(server, "/v1/config/example/missing")), "value"), false);
    assert.equal(success(await http(server, "/v1/config/example/literalNull")).value, null);
    assert.equal(Object.hasOwn(value, 1), false); assert.deepEqual(effects(fixture), before);
  } finally { await root?.dispose(); await server?.close(); await fixture.cleanup(); }
});

for (const environment of ["dev", "production"]) {
  for (const dialect of [false, true]) {
    test(`real JWT/FS direct and HTTP parity ${environment} loadLayer=${dialect}`, async () => {
      const fixture = await filesystemHost({ environment, dialect });
      const direct = await filesystemHost({ environment, dialect });
      let server, root;
      try {
        server = await startWeaverServer(fixture.options);
        const local = await directPort(direct); root = local.root;
        const path = "/v1/config/example/name";
        assert.equal(success(await http(server, path)).value, local.port.get(["name"]));
        assert.deepEqual(semanticInspection(success(await http(server, `${path}?inspect`))),
          semanticInspection(local.port.inspect(["name"])));
        const initial = (await http(server, path)).body.meta.revision;
        const localInitial = local.port.revision;
        const written = success(await http(server, `${path}?layer=late`, { method: "PUT", body: { value: "new" }, headers: { "if-match": `"${initial}"` } }));
        const localWrite = await local.mutations.apply([{ ...local.selection, operation: "set", path: "/example/name", value: "new", ifRevision: localInitial }]);
        assert.equal(localWrite.success, true); assert.equal(written.success, true);
        assert.equal(written.revisions[0].revision, (await http(server, path)).body.meta.revision);
        rejected(await http(server, `${path}?layer=late`, { method: "PUT", body: { value: "stale" }, headers: { "if-match": initial } }), 409, "REVISION_CONFLICT", "rejected");
        assert.equal((await local.mutations.apply([{ ...local.selection, operation: "set", path: "/example/name", value: "stale", ifRevision: localInitial }])).error.code, "REVISION_CONFLICT");
        rejected(await http(server, `${path}?layer=late`, { method: "PUT", body: { value: 7 } }), 400, "VALIDATION_ERROR", "rejected");
        assert.equal((await local.mutations.apply([{ ...local.selection, operation: "set", path: "/example/name", value: 7 }])).error.code, "VALIDATION_ERROR");
        rejected(await http(server, "/v1/config/example/blocked?layer=late", { method: "PUT", body: { value: "denied" } }), 400, "POLICY_VIOLATION", "rejected");
        assert.equal((await local.mutations.apply([{ ...local.selection, operation: "set", path: "/example/blocked", value: "denied" }])).error.code, "POLICY_VIOLATION");
        success(await http(server, `${path}?layer=late`, { method: "DELETE" }));
        assert.equal((await local.mutations.apply([{ ...local.selection, operation: "remove", path: "/example/name" }])).success, true);
        assert.deepEqual(semanticInspection(success(await http(server, `${path}?inspect`))), semanticInspection(local.port.inspect(["name"])));
        const old = (await http(server, path)).body.meta.revision;
        await server.close(); server = await startWeaverServer(fixture.options);
        assert.equal(success(await http(server, path)).value, "base");
        rejected(await http(server, `${path}?layer=late`, { method: "PUT", body: { value: "old-root" }, headers: { "if-match": old } }), 409, "REVISION_CONFLICT", "rejected");
        const binding = fixture.authority.configuration.providers[0];
        const stored = dialect ? await binding.provider.loadLayer(binding.operation.layer) : await binding.provider.load();
        assert.deepEqual(stored.entries._weaver.registry.schemas, fixture.registry.serialized);
        console.log(`authority listener localhost:${server.port} ${environment} dialect=${dialect}`);
      } finally { await server?.close(); await root?.dispose(); await fixture.cleanup(); await direct.cleanup(); }
    });
  }
}

test("lossless literal/Unicode paths, scoped order, two principals and strict selectors", async () => {
  const fixture = await filesystemHost({ initialScope: [{ scopeId: "tenant", value: "a" }] });
  const server = await startWeaverServer(fixture.options);
  try {
    assert.equal(success(await http(server, "/v1/config/example/name")).value, "tenant-a");
    assert.equal(success(await http(server, "/v1/config/example/count")).value, 3);
    assert.equal(success(await http(server, "/v1/config/example/name?scope=")).value, "base");
    success(await http(server, "/v1/config/example/name?layer=tenant", { method: "PUT", body: { value: "scoped" } }));
    assert.equal(success(await http(server, "/v1/config/example/name")).value, "scoped");
    for (const [segment, value] of [["literal.dot", "dot"], ["%E9%9B%AA", null]]) {
      success(await http(server, `/v1/config/example/${segment}?scope=&layer=late`, { method: "PUT", body: { value } }));
      assert.equal(success(await http(server, `/v1/config/example/${segment}?scope=`)).value, value);
    }
    const bob = jwt({ sub: "bob" });
    assert.equal(success(await http(server, "/v1/config/other/name?scope=tenant:b", { token: bob })).value, "tenant-b");
    rejected(await http(server, "/v1/config/example/name?scope=tenant:a", { token: bob }), 403, "FORBIDDEN");
    const before = effects(fixture);
    rejected(await http(server, "/v1/config/example/%5Bliteral%5D?scope=&layer=late", { method: "PUT", body: { value: "bracket" } }), 400, "VALIDATION_ERROR");
    for (const query of ["scope=a:b:c", "scope=tenant:a,tenant:b", "scope=:a", "env=other", "roles=admin", "inspect=yes", "scope=tenant:a&scope=tenant:b"]) {
      const response = await http(server, `/v1/config/example/name?${query}`);
      assert.equal(response.status, query === "env=other" ? 403 : 400, query);
    }
    for (const value of ["", "*", "W/abc", '""', '"a", "b"', '"broken'])
      rejected(await http(server, "/v1/config/example/name?scope=&layer=late", { method: "PUT", body: { value: "bad" }, headers: { "if-match": value } }), 400, "VALIDATION_ERROR");
    for (const body of [{}, { value: "bad", actor: "root" }, { value: "bad", roles: ["admin"] }])
      rejected(await http(server, "/v1/config/example/name?layer=tenant", { method: "PUT", body }), 400, "VALIDATION_ERROR");
    rejected(await http(server, "/v1/config/example/name?layer=tenant", { method: "DELETE", body: { value: "bad" } }), 400, "VALIDATION_ERROR");
    assert.deepEqual(effects(fixture), before);
  } finally { await server.close(); await fixture.cleanup(); }
});

test("real JWT denial precedes mapping, unsupported routes never mutate", async () => {
  const fixture = await filesystemHost(); let mapped = 0;
  const original = fixture.authority.mapPrincipal;
  fixture.authority.mapPrincipal = function (...args) { mapped++; return original.apply(this, args); };
  const server = await startWeaverServer(fixture.options);
  try {
    const before = effects(fixture);
    for (const token of [null, "malformed", jwt({}, "wrong"), jwt({}, undefined, "HS512"), jwt({ exp: 1 }), jwt({ exp: "tomorrow" })])
      rejected(await http(server, "/v1/config/example/name", { token }), 401, "UNAUTHORIZED");
    assert.equal(mapped, 0);
    for (const path of ["/v1/events", "/v1/config", "/v1/config/batch", "/v1/admin/reload", "/v1/registered/example", "/v1/scopes/tenant"]) {
      rejected(await http(server, path), 501, "UNSUPPORTED_OPERATION");
      rejected(await http(server, path, { method: "POST", body: { value: "bad" } }), 501, "UNSUPPORTED_OPERATION");
    }
    rejected(await http(server, "/v1/config/example/name", { method: "PATCH", body: {} }), 501, "UNSUPPORTED_OPERATION");
    rejected(await http(server, "/v1/unknown"), 404, "NOT_FOUND");
    assert.equal((await http(server, "/scomp")).status, 404);
    assert.equal((await http(server, "/healthz", { token: null })).status, 200);
    assert.equal((await http(server, "/readyz", { token: null })).status, 200);
    assert.equal((await http(server, "/v1/config/example/name", { method: "OPTIONS", token: null })).status, 204);
    assert.equal(mapped, 0); assert.deepEqual(effects(fixture), before);
  } finally { await server.close(); await fixture.cleanup(); }
});

test("required flush holds HTTP response and publication; expiry after dispatch preserves success", async () => {
  const fixture = await filesystemHost(); const entered = deferred(), release = deferred();
  let clock = Date.now(); const expiry = Math.floor(clock / 1000) + 600;
  fixture.authority.now = () => clock;
  fixture.controls.late.flush = async () => { entered.resolve(); await release.promise; clock = (expiry + 1) * 1000; };
  const server = await startWeaverServer(fixture.options);
  try {
    let done = false;
    const write = http(server, "/v1/config/example/name?layer=late", { method: "PUT", token: jwt({ exp: expiry }), body: { value: "committed" } }).then((value) => { done = true; return value; });
    await entered.promise;
    assert.equal(done, false);
    assert.equal(success(await http(server, "/v1/config/example/name")).value, "base");
    assert.equal(success(await http(server, "/v1/config/example/name?inspect")).effective.value, "base");
    release.resolve();
    const response = await write; const data = success(response);
    assert.equal(data.success, true); assert.equal(data.revisions[0].revision, response.body.meta.revision);
    assert.equal(fixture.controls.late.calls.flush, 1);
    const binding = fixture.authority.configuration.providers.at(-1);
    assert.equal((await binding.provider.load()).entries.example.name, "committed");
  } finally { release.resolve(); await server.close(); await fixture.cleanup(); }
});

test("unknown required-flush outcome stays canonical, fenced, degraded and never retries", async () => {
  const fixture = await filesystemHost();
  fixture.controls.late.flush = () => { throw new Error("SECRET provider message"); };
  const server = await startWeaverServer(fixture.options);
  try {
    rejected(await http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: "uncertain" } }), 500, "WRITE_OUTCOME_UNKNOWN", "unknown");
    const counts = effects(fixture);
    rejected(await http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: "retry" } }), 503, "WRITE_UNAVAILABLE", "rejected");
    assert.deepEqual(effects(fixture), counts);
    assert.equal(server.isReady, false);
    const ready = await http(server, "/readyz", { token: null });
    assert.equal(ready.status, 503); assert.deepEqual(Object.keys(ready.body).sort(), ["status", "uptime"]);
    assert.equal(success(await http(server, "/v1/config/example/name")).value, "uncertain");
  } finally { await server.close(); await fixture.cleanup(); }
});

test("complete preparation READ grant is required and request data never elevates permission", async () => {
  const fixture = await filesystemHost();
  const map = fixture.authority.mapPrincipal;
  fixture.authority.mapPrincipal = (context, identity) => ({ ...map(context, identity),
    grants: map(context, identity).grants.map((grant) => ({ ...grant, operations: ["write"] })),
  });
  const server = await startWeaverServer(fixture.options);
  try {
    const before = effects(fixture), loads = Object.values(fixture.controls).map(({ calls }) => calls.load);
    rejected(await http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: "no-read-grant" } }), 403, "FORBIDDEN");
    rejected(await http(server, "/v1/config/example/name?layer=late&actor=admin", { method: "PUT", body: { value: "bad" } }), 400, "VALIDATION_ERROR");
    rejected(await http(server, "/v1/config/example/name?layer=late&session=emergency", { method: "PUT", body: { value: "bad" } }), 400, "VALIDATION_ERROR");
    assert.deepEqual(effects(fixture), before);
    assert.deepEqual(Object.values(fixture.controls).map(({ calls }) => calls.load), loads);
  } finally { await server.close(); await fixture.cleanup(); }
});

test("warm policy denial and schema rejection preserve revision/effects; public aggregates use canonical responses", async () => {
  const fixture = await filesystemHost(); let allow = false;
  fixture.authority.hostAuthority.authorizeWrite = async () => allow ? "allowed" : "denied";
  const server = await startWeaverServer(fixture.options);
  try {
    const first = await http(server, "/v1/config/example/name");
    const before = effects(fixture);
    rejected(await http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: "denied" } }), 403, "FORBIDDEN", "rejected");
    allow = true;
    rejected(await http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: 9 } }), 400, "VALIDATION_ERROR", "rejected");
    rejected(await http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: {} } }), 400, "VALIDATION_ERROR", "rejected");
    assert.equal(success(await http(server, "/v1/config/example")).value.name, "base");
    assert.equal(success(await http(server, "/v1/config/example?inspect")).effective.value.name, "base");
    assert.equal((await http(server, "/v1/config/example/name?view=private")).status, 400);
    assert.equal((await http(server, "/v1/config/example/name")).body.meta.revision, first.body.meta.revision);
    assert.deepEqual(effects(fixture), before);
  } finally { await server.close(); await fixture.cleanup(); }
});

for (const outcome of ["throw", "malformed"]) {
  test(`actual FS dispatched ${outcome} returns unknown with one readback and no replay`, async () => {
    const fixture = await filesystemHost();
    fixture.controls.late.outcome = () => { if (outcome === "throw") throw new Error("SECRET"); return { unexpected: "SECRET" }; };
    const server = await startWeaverServer(fixture.options);
    try {
      const loads = fixture.controls.late.calls.load;
      const response = await http(server, "/v1/config/example/name?layer=late", { method: "PUT", body: { value: "uncertain" } });
      rejected(response, 500, "WRITE_OUTCOME_UNKNOWN", "unknown");
      assert.doesNotMatch(JSON.stringify(response.body), /SECRET/);
      assert.equal(fixture.controls.late.calls.load, loads + 1);
      assert.equal(fixture.controls.late.calls.write, 1);
      assert.equal(fixture.controls.late.calls.flush, 1);
      rejected(await http(server, "/v1/config/example/name?layer=late", { method: "DELETE" }), 503, "WRITE_UNAVAILABLE", "rejected");
      assert.equal(fixture.controls.late.calls.remove, 0);
    } finally { await server.close(); await fixture.cleanup(); }
  });
}

function rawBodyRequest(server, path, { method = "DELETE", contentType, framing = "length", payload = "" }) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${jwt()}` };
    if (contentType !== undefined) headers["content-type"] = contentType;
    if (framing === "length") headers["content-length"] = String(Buffer.byteLength(payload));
    if (framing === "chunked") headers["transfer-encoding"] = "chunked";
    const request = httpRequest({ host: "127.0.0.1", port: server.port, path, method, headers, agent: false }, (response) => {
      let text = "";
      response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; });
      response.once("error", reject);
      response.once("end", () => {
        try { resolve({ status: response.statusCode, headers: new Headers(response.headers), body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    assert.equal(request.getHeader("content-type"), contentType);
    request.setTimeout(5000, () => request.destroy(new Error("Raw body request timed out")));
    request.once("error", reject);
    if (framing === "chunked") request.write(payload.slice(0, 1));
    request.end(framing === "chunked" ? payload.slice(1) : payload);
  });
}

async function bodyValidationHost() {
  const fixture = await filesystemHost(), callbacks = { map: 0, read: 0, write: 0 };
  const map = fixture.authority.mapPrincipal, host = fixture.authority.hostAuthority;
  const read = host.authorizeReadSync, write = host.authorizeWrite;
  fixture.authority.mapPrincipal = function (...args) { callbacks.map++; return Reflect.apply(map, this, args); };
  host.authorizeReadSync = function (...args) { callbacks.read++; return Reflect.apply(read, this, args); };
  host.authorizeWrite = function (...args) { callbacks.write++; return Reflect.apply(write, this, args); };
  return { ...fixture, callbacks };
}
function bodyObservation(fixture) {
  return { callbacks: { ...fixture.callbacks },
    providers: Object.fromEntries(Object.entries(fixture.controls).map(([id, { calls }]) => [id, { ...calls }])),
  };
}

const invalidDeleteBodies = [
  ["text/plain", '{"actor":"injected","unexpected":true}'],
  ["application/octet-stream", "unparsed"],
  [undefined, '{"actor":"injected","unexpected":true}'],
  ["application/x-www-form-urlencoded", "actor=injected&unexpected=true"],
  ["application/x-www-form-urlencoded", "&&"],
  ["application/vnd.weaver+json", "{}"],
  ["application/json", '{"actor":"injected","unexpected":true}'],
  ["application/json", "[]"],
];
for (const [contentType, payload] of invalidDeleteBodies) {
  for (const framing of ["length", "chunked"]) {
    for (const cold of [false, true]) {
      test(`DELETE body boundary rejects ${contentType ?? "missing type"} ${JSON.stringify(payload)} ${framing} cold=${cold} before authority/IO`, async () => {
        const fixture = await bodyValidationHost(); const server = await startWeaverServer(fixture.options);
        try {
          const beforeRead = await http(server, "/v1/config/example/name");
          const file = join(fixture.directory, cold ? "a.json" : "base.json");
          const beforeBytes = await readFile(file, "utf8"), before = bodyObservation(fixture);
          assert.equal(fixture.controls.a.calls.load, 0);
          const path = `/v1/config/example/name?layer=${cold ? "tenant&scope=tenant:a" : "base"}`;
          const response = await rawBodyRequest(server, path, { contentType, framing, payload });
          const afterBytes = await readFile(file, "utf8"), after = bodyObservation(fixture);
          assert.equal(response.status, 400, JSON.stringify({ response: response.body, before, after, persistedName: JSON.parse(afterBytes).example?.name ?? null }));
          rejected(response, 400, "VALIDATION_ERROR"); assert.equal(response.body.data, null);
          assert.doesNotMatch(JSON.stringify(response.body), /injected|unexpected|unparsed/);
          assert.deepEqual(after, before); assert.equal(afterBytes, beforeBytes);
          const afterRead = await http(server, "/v1/config/example/name");
          assert.deepEqual(afterRead.body.data, beforeRead.body.data);
          assert.equal(afterRead.body.meta.revision, beforeRead.body.meta.revision);
        } finally { await server.close(); await fixture.cleanup(); }
      });
    }
  }
}

for (const body of [
  { framing: "none" },
  { framing: "length" },
  { contentType: "text/plain" },
  { contentType: "application/octet-stream" },
  { contentType: "application/x-www-form-urlencoded" },
  { contentType: "application/json" },
  { contentType: "application/json", payload: "{}" },
  { contentType: "application/json; charset=utf-8", framing: "chunked", payload: "{}" },
]) {
  test(`DELETE body boundary accepts absent or JSON{} ${JSON.stringify(body)}`, async () => {
    const fixture = await filesystemHost(); const server = await startWeaverServer(fixture.options);
    try {
      success(await http(server, "/v1/config/example/name?layer=base", { method: "PUT", body: { value: "reset" } }));
      const before = bodyObservation({ ...fixture, callbacks: {} });
      const result = success(await rawBodyRequest(server, "/v1/config/example/name?layer=base", body));
      assert.equal(result.success, true);
      assert.equal(fixture.controls.base.calls.remove, before.providers.base.remove + 1);
      assert.equal(fixture.controls.base.calls.flush, before.providers.base.flush + 1);
      assert.equal(fixture.controls.base.calls.write, before.providers.base.write);
      const stored = JSON.parse(await readFile(join(fixture.directory, "base.json"), "utf8"));
      assert.equal(stored.example.name, undefined);
      assert.equal(Object.hasOwn(success(await http(server, "/v1/config/example/name")), "value"), false);
    } finally { await server.close(); await fixture.cleanup(); }
  });
}

test("PUT body boundary still rejects unsupported framed payloads before authority/IO", async () => {
  const fixture = await bodyValidationHost(); const server = await startWeaverServer(fixture.options);
  try {
    const beforeRead = await http(server, "/v1/config/example/name"), before = bodyObservation(fixture);
    for (const contentType of [undefined, "text/plain", "application/octet-stream", "application/x-www-form-urlencoded"]) {
      const response = await rawBodyRequest(server, "/v1/config/example/name?layer=base", {
        method: "PUT", contentType, framing: "chunked", payload: '{"value":"injected"}',
      });
      rejected(response, 400, "VALIDATION_ERROR"); assert.deepEqual(bodyObservation(fixture), before);
    }
    const after = await http(server, "/v1/config/example/name");
    assert.deepEqual(after.body.data, beforeRead.body.data); assert.equal(after.body.meta.revision, beforeRead.body.meta.revision);
  } finally { await server.close(); await fixture.cleanup(); }
});

test("DELETE body boundary conservatively rejects unsupported empty chunked entities", async () => {
  const fixture = await bodyValidationHost(); const server = await startWeaverServer(fixture.options);
  try {
    const before = bodyObservation(fixture);
    for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
      rejected(await rawBodyRequest(server, "/v1/config/example/name?layer=base", {
        contentType, framing: "chunked", payload: "",
      }), 400, "VALIDATION_ERROR");
      assert.deepEqual(bodyObservation(fixture), before);
    }
  } finally { await server.close(); await fixture.cleanup(); }
});
