import assert from "node:assert/strict";
import { test } from "node:test";
import { authConfig, hosted, principal } from "./fixtures/authority.mjs";
import { MemoryProvider, options, registration, scopeOptions, viewSchema } from "./fixtures/memory.mjs";
import { schemaClaims } from "./fixtures/live-registry.mjs";

async function fixture() {
  const low = new MemoryProvider("low", "base", { alpha: {
    flag: "base", panel: { a: 1, b: 2 }, list: [1, 2], hidden: "BASE-SECRET", admin: "ADMIN",
    instances: { "literal.dot": { flag: null, panel: { a: 3 }, list: [9], "雪": "view", hidden: "VIEW-SECRET" }, other: { flag: "other-view" } },
  } });
  const high = new MemoryProvider("high", "high", { alpha: { flag: "high", panel: { a: 99 }, "literal.dot": "literal" } });
  const input = options([low, high], { schemas: [registration("east", "alpha", viewSchema())] });
  const setup = await hosted(input);
  const claims = principal(input);
  claims.grants.push({ ...claims.grants[0], views: ["literal.dot", "other", "absent"] });
  const token = setup.controller.mint(claims);
  const reader = setup.controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" });
  return { ...setup, low, high, reader, claims };
}

test("engine-issued views inherit objects, replace arrays/null and preserve exact physical origin", async () => {
  const setup = await fixture();
  try {
    const view = setup.reader.forView("literal.dot");
    assert.throws(() => view.get(), { code: "SCOPE_NOT_LOADED" });
    const revision = setup.reader.revision;
    await view.prepare();
    assert.equal(view.revision, revision);
    assert.deepEqual(view.get(["panel"]), { a: 3, b: 2 });
    assert.deepEqual(view.get(["list"]), [9]);
    assert.equal(view.get(["flag"], { defaultValue: "wrong" }), null);
    assert.equal(view.get(["literal.dot"]), "literal");
    assert.equal(view.get(["雪"]), "view");
    assert.deepEqual(view.snapshot(["panel"]).value, { state: "value", value: { a: 3, b: 2 } });
    assert.equal(view.get(["panel", "a"], { layer: "base" }), 3);
    assert.equal(view.get(["panel", "a"], { layer: "high" }), 99);
    const trace = view.inspect(["panel", "a"]);
    assert.equal(trace.path, "/alpha/panel/a");
    assert.equal(trace.effectiveLayer, "base");
    assert.equal(trace.effectiveSource, "view");
    assert.equal(trace.viewId, "literal.dot");
    assert.deepEqual(trace.contributions.map((item) => [item.layer, item.source, item.sourcePath]), [
      ["base", "base", "/alpha/panel/a"], ["high", "base", "/alpha/panel/a"],
      ["base", "view", "/alpha/instances/literal.dot/panel/a"], ["high", "view", "/alpha/instances/literal.dot/panel/a"],
    ]);
    assert.equal(view.inspect(["panel"]).effectiveLayer, undefined);
    assert.equal(view.inspect(["panel"]).effectiveSource, undefined);
    assert.throws(() => view.validate(), { code: "FORBIDDEN" });
    const claims = { ...setup.claims, grants: setup.claims.grants.map((grant) => ({ ...grant, sensitive: true })) };
    const privileged = setup.controller.forIdentity(setup.controller.mint(claims), view.selection);
    assert.equal(privileged.validate().validation.valid, true);
    assert.equal(setup.low.loads + setup.high.loads, 2);
    const absent = view.forView("absent"); await absent.prepare();
    assert.equal(absent.get(["flag"]), "high");
    assert.equal(view.forView().get(["flag"]), "high");
    assert.equal(view.get(["flag"]), null);
    assert.equal(Object.hasOwn(view.get(), "instances"), false);
    assert.throws(() => setup.reader.get(["instances", "literal.dot"]), { code: "FORBIDDEN" });
    assert.throws(() => view.forView("ungranted"), { code: "FORBIDDEN" });
  } finally { await setup.root.dispose(); }
});

test("view and base grants stay separate; sensitive access is current complete grant plus host roles", async () => {
  const setup = await fixture();
  try {
    const claims = { ...setup.claims, grants: setup.claims.grants.filter((grant) => grant.views.length).map((grant) => ({ ...grant, sensitive: true })) };
    const reader = setup.controller.forIdentity(setup.controller.mint(claims), { identity: setup.input.identity, namespace: "/alpha", viewId: "literal.dot" });
    await reader.prepare();
    assert.equal(reader.get(["hidden"]), "VIEW-SECRET");
    assert.equal(reader.get(["admin"]), "ADMIN");
    assert.throws(() => reader.forView(), { code: "FORBIDDEN" });
    const publicView = setup.reader.forView("literal.dot"); await publicView.prepare();
    assert.throws(() => publicView.get(["hidden"], { defaultValue: "wrong" }), { code: "FORBIDDEN" });
    assert.equal(publicView.inspect(["hidden"]).effective.state, "redacted");
    assert.doesNotMatch(JSON.stringify(publicView.snapshot()), /SECRET/);
    const schemas = setup.controller.forSchemas(setup.controller.mint(schemaClaims(setup.input)));
    const request = structuredClone(setup.input.schemas[0]);
    request.schema.properties.instances.additionalProperties.properties.flag["x-weaver"] = { sensitive: true };
    assert.equal((await schemas.register(request)).success, true);
    assert.throws(() => publicView.get(["flag"]), { code: "FORBIDDEN" });
    assert.equal(publicView.inspect(["flag"]).effective.state, "redacted");
    assert.equal(reader.get(["flag"]), null);
    assert.equal(setup.reader.get(["flag"]), "high");
    delete request.schema.properties.instances;
    assert.equal((await schemas.register(request)).success, true);
    assert.throws(() => reader.get(["flag"]), { code: "SCHEMA_NOT_REGISTERED" });
    assert.equal(setup.root.mode, "live");
  } finally { await setup.root.dispose(); }
});

test("view validation reports invalid logical data and still intersects physical metadata after publication", async () => {
  const schema = { type: "object", properties: {
    count: { type: "number" },
    instances: { type: "object", additionalProperties: { type: "object", properties: { count: { type: "number" } } } },
  }, anyOf: [{ type: "object", properties: { count: { type: "number", minimum: 10 } } }] };
  const provider = new MemoryProvider("p", "base", { alpha: { count: 12, instances: { one: { count: 2 } } } });
  const input = options([provider], { schemas: [registration("east", "alpha", schema)] });
  const setup = await hosted(input), claims = principal(input);
  claims.grants[0].views = ["one"];
  try {
    const reader = setup.controller.forIdentity(setup.controller.mint(claims), { identity: input.identity, namespace: "/alpha", viewId: "one" });
    await reader.prepare();
    assert.equal(reader.validate().validation.valid, false);
    assert.throws(() => reader.get(), { code: "FORBIDDEN" });
    const schemas = setup.controller.forSchemas(setup.controller.mint(schemaClaims(input)));
    const request = structuredClone(input.schemas[0]);
    request.schema.properties.instances.additionalProperties.properties.count["x-weaver"] = { sensitive: true };
    assert.equal((await schemas.register(request)).success, true);
    assert.throws(() => reader.validate(), { code: "FORBIDDEN" });
    assert.equal(provider.loads, 1);
  } finally { await setup.root.dispose(); }
});

test("nested literal view namespaces isolate ordered scopes, replacement views and independent roots", async () => {
  const scope = scopeOptions(), namespace = "/alpha/literal.dot/雪";
  const wrapped = (value) => ({ alpha: { "literal.dot": { "雪": value } } });
  scope.base.entries = wrapped({ flag: "base", instances: { one: { flag: "base-view" }, two: { flag: "second-view" } } });
  scope.last.entries = wrapped({ panel: { b: 9 } });
  scope.first.entries = wrapped({ instances: { one: { flag: "tenant-one" } } });
  scope.second.entries = wrapped({ instances: { one: { flag: "tenant-two" } } });
  scope.input.schemas = [registration("east", "alpha", { type: "object", properties: {
    "literal.dot": { type: "object", properties: { "雪": viewSchema() } },
  } })];
  const a = await hosted(scope.input);
  const west = new MemoryProvider("west", "base", wrapped({ flag: "west", instances: { one: { flag: "west-view" } } }));
  const westInput = options([west], { identity: { environment: "west", scopePath: [] },
    schemas: [{ ...structuredClone(scope.input.schemas[0]), environment: "west" }] });
  const b = await hosted(westInput);
  try {
    const claims = principal(scope.input);
    claims.grants = [[], scope.path1, scope.path2].map((scopePath) => ({ ...claims.grants[0], identity: { environment: "east", scopePath }, views: ["one", "two"] }));
    const token = a.controller.mint(claims);
    const reader = a.controller.forIdentity(token, { identity: scope.input.identity, namespace, viewId: "one" });
    const one = reader.withScope(scope.path1), two = one.withScope(scope.path2);
    assert.equal(scope.first.loads + scope.second.loads, 0);
    await Promise.all([reader.prepare(), one.prepare(), two.prepare()]);
    assert.equal(reader.get(["flag"]), "base-view");
    assert.equal(one.get(["flag"]), "tenant-one"); assert.equal(two.get(["flag"]), "tenant-two");
    assert.deepEqual(two.selection.identity.scopePath, scope.path2);
    const second = one.forView("two"); await second.prepare();
    assert.equal(second.get(["flag"]), "second-view");
    assert.equal(one.inspect(["flag"]).path, `${namespace}/flag`);
    assert.equal(one.inspect(["flag"]).contributions.find((item) => item.providerId === "first" && item.source === "view").sourcePath, `${namespace}/instances/one/flag`);
    assert.throws(() => one.forView(), { code: "FORBIDDEN" });
    assert.throws(() => one.get(["instances", "two"]), { code: "FORBIDDEN" });
    assert.throws(() => b.controller.forIdentity(token, { identity: westInput.identity, namespace, viewId: "one" }), { code: "FORBIDDEN" });
    const westClaims = principal(westInput); westClaims.grants[0].views = ["one"];
    const westReader = b.controller.forIdentity(b.controller.mint(westClaims), { identity: westInput.identity, namespace, viewId: "one" });
    await westReader.prepare(); assert.equal(westReader.get(["flag"]), "west-view");
    assert.equal(two.get(["flag"]), "tenant-two");
    assert.equal(scope.first.loads, 1); assert.equal(scope.second.loads, 1); assert.equal(west.loads, 1);
  } finally { await a.root.dispose(); await b.root.dispose(); }
});

async function sharedPolicyFixture(shared, restriction) {
  const leaf = { type: "string" }, logical = { type: "object", properties: { value: { type: "string" } } };
  const physical = { type: "object", properties: {
    a: { type: "object", properties: { value: leaf }, "x-weaver": { visibility: "admin" } },
    b: { type: "object", properties: { value: shared ? leaf : { type: "string" } }, "x-weaver": restriction },
  } };
  const schema = { type: "object", properties: { a: logical, b: logical,
    instances: { type: "object", additionalProperties: physical },
  } };
  const provider = new MemoryProvider("p", "base", { alpha: {
    a: { value: "PUBLIC" }, b: { value: "UNIQUE_SECRET" }, instances: { one: { a: {}, b: {} } },
  } });
  const input = options([provider], { schemas: [registration("east", "alpha", schema)] });
  const auth = authConfig(input); auth.visibilityRoles.platform = new Set(["platform"]);
  const requests = [], setup = await hosted(input, { authConfig: auth, hostAuthority: {
    authorizeReadSync(_actor, request) { requests.push(request); return "allowed"; },
    async authorizeWrite() { return "denied"; },
  } });
  const issue = async (elevated = false) => {
    const claims = principal(input); claims.grants[0].views = ["one"];
    if (elevated) { claims.grants[0].sensitive = true; claims.roles.push("platform"); }
    const reader = setup.controller.forIdentity(setup.controller.mint(claims), { identity: input.identity, namespace: "/alpha", viewId: "one" });
    await reader.prepare(); return reader;
  };
  return { ...setup, provider, requests, issue };
}

for (const restriction of [{ sensitive: true }, { visibility: "platform" }]) {
  for (const shared of [false, true]) for (const order of ["cold", "a-first", "b-first"]) {
    test(`physical inherited policy survives shared=${shared} order=${order} ${JSON.stringify(restriction)}`, async () => {
      const setup = await sharedPolicyFixture(shared, restriction);
      try {
        const reader = await setup.issue();
        const denied = () => {
          assert.throws(() => reader.get(["b", "value"]), { code: "FORBIDDEN" });
          assert.throws(() => reader.get(["b", "value"], { defaultValue: "fallback" }), { code: "FORBIDDEN" });
          assert.throws(() => reader.get(["b", "value"], { layer: "base" }), { code: "FORBIDDEN" });
          assert.throws(() => reader.snapshot(["b", "value"]), { code: "FORBIDDEN" });
          assert.deepEqual(reader.inspect(["b", "value"]).effective, { state: "redacted" });
        };
        if (order === "b-first") denied();
        if (order !== "cold") {
          assert.equal(reader.get(["a", "value"]), "PUBLIC");
          assert.equal(reader.get(["a", "value"], { layer: "base" }), "PUBLIC");
          assert.equal(reader.snapshot(["a", "value"]).value.value, "PUBLIC");
          assert.equal(reader.inspect(["a", "value"]).effective.value, "PUBLIC");
        }
        denied(); denied();
        assert.deepEqual(reader.get(), { a: { value: "PUBLIC" } });
        assert.deepEqual(reader.snapshot().value.value, { a: { value: "PUBLIC" } });
        assert.throws(() => reader.validate(), { code: "FORBIDDEN" });
        assert.equal(setup.requests.some((request) => request.path === "/alpha/b/value"), false);
        const elevated = await setup.issue(true);
        assert.equal(elevated.get(["b", "value"]), "UNIQUE_SECRET");
        assert.equal(elevated.get(["b", "value"], { layer: "base" }), "UNIQUE_SECRET");
        assert.equal(elevated.inspect(["b", "value"]).effective.value, "UNIQUE_SECRET");
        assert.equal(elevated.snapshot(["b", "value"]).value.value, "UNIQUE_SECRET");
        assert.equal(elevated.validate().validation.valid, true);
        assert.ok(setup.requests.filter((request) => request.path === "/alpha/b/value").every((request) => request.sensitive === (restriction.sensitive === true)));
        denied();
        assert.equal(setup.provider.loads, 1);
      } finally { await setup.root.dispose(); }
    });
  }
}
