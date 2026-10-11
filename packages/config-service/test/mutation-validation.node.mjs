import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configurationValidationResponseSchema } from "@weaver-conf/config-types";
import { hosted, principal } from "./fixtures/authority.mjs";
import { MemoryProvider, options, registration, scopeOptions } from "./fixtures/memory.mjs";
import { schemaClaims } from "./fixtures/live-registry.mjs";
import { withConsumer } from "./fixtures/packed-consumer.mjs";

async function fixture(schema, value, host = {}, factory) {
  const provider = new MemoryProvider("p", "base", { alpha: value });
  const input = options([provider], { schemas: [registration("east", "alpha", schema)] });
  const setup = await hosted(input, host, factory);
  const token = setup.controller.mint(principal(input));
  return { ...setup, provider, token, port: setup.controller.forIdentity(token, { identity: input.identity, namespace: "/alpha" }) };
}

test("validate is a synchronous zero-IO exact-anchor query over raw engine state with sanitized diagnostics", async () => {
  const schema = { type: "object", required: ["mode", "count"], properties: {
    mode: { type: "string", enum: ["PRIVATE-SCHEMA-LITERAL"] }, count: { type: "number" },
  } };
  const setup = await fixture(schema, { mode: "invalid-public-value", count: "invalid-number" });
  try {
    const response = setup.port.validate();
    assert.equal(response instanceof Promise, false);
    assert.equal(response.validation.valid, false);
    assert.ok(response.validation.errors.length >= 2);
    assert.ok(response.validation.errors.some((error) => error.path.includes("count")));
    assert.equal(configurationValidationResponseSchema.safeParse(response).success, true);
    assert.equal(response.revision, setup.port.revision);
    assert.deepEqual(response.identity, setup.input.identity);
    assert.ok(Object.isFrozen(response.validation.errors));
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE-SCHEMA-LITERAL|invalid-public-value|invalid-number/);
    assert.throws(() => setup.port.validate(["count"]), { code: "SCHEMA_NOT_REGISTERED" });
    assert.throws(() => setup.controller.forIdentity(setup.token, { identity: setup.input.identity, namespace: "/beta" }), { code: "FORBIDDEN" });
    assert.equal(setup.provider.loads, 1);
    assert.equal(setup.provider.writes + setup.provider.removes + setup.provider.flushes, 0);
  } finally { await setup.root.dispose(); }
});

test("public composed, pattern and explicit wildcard aggregates share projected get/layer/inspection", async () => {
  const branch = (kind) => ({ type: "object", additionalProperties: true, properties: {
    kind: { type: "string", const: kind }, value: { type: "number" },
  } });
  const schema = { type: "object", additionalProperties: true, properties: {
    choices: { type: "object", anyOf: [branch("a"), branch("b")] },
    exclusive: { type: "object", oneOf: [branch("a"), branch("b")] },
    combined: { type: "object", allOf: [{ type: "object", properties: { count: { type: "number" } } }] },
    negative: { type: "string", not: { type: "string", enum: ["bad"] } },
    list: { type: "array" },
    patterned: { type: "object", patternProperties: { "^x": { type: "number" } } },
    hidden: { type: "string", "x-weaver": { sensitive: true } },
  } };
  const value = { choices: { kind: "a", value: 2 }, exclusive: { kind: "b", value: 3 },
    combined: { count: 4 }, negative: "good", list: [null, { nested: [1, "雪"] }],
    patterned: { x1: 9 }, free: { arbitrary: [false, { deep: null }] }, hidden: "PRIVATE",
    ref: { _weaver: "secret-ref", key: "PRIVATE" }, mount: { _weaver: "mount", path: "/alpha/hidden" },
  };
  const setup = await fixture(schema, value);
  try {
    const { hidden, ref, mount, ...expected } = value;
    assert.deepEqual(setup.port.get(), expected);
    assert.deepEqual(setup.port.snapshot().value.value, expected);
    assert.deepEqual(setup.port.get([], { layer: "base" }), expected);
    assert.deepEqual(setup.port.inspect().effective.value, expected);
    assert.deepEqual(setup.port.get(["free", "arbitrary", "1"]), { deep: null });
    for (const path of [["hidden"], ["ref", "key"], ["mount", "path"]])
      assert.throws(() => setup.port.get(path), { code: "FORBIDDEN" });
    assert.throws(() => setup.port.validate(), { code: "FORBIDDEN" });
    assert.doesNotMatch(JSON.stringify(setup.port.inspect()), /PRIVATE/);
  } finally { await setup.root.dispose(); }
});

test("validate uses inspect plus subtree read authority, not schema-admin permission or filtered data", async () => {
  for (const policy of [{ sensitive: true }, { visibility: "internal" }, { visibility: "admin" }]) {
    const setup = await fixture({ type: "object", properties: {
      flag: { type: "number" }, hidden: { type: "number", "x-weaver": policy },
    } }, { flag: 1, hidden: "PRIVATE-invalid" });
    try {
      const publicClaims = principal(setup.input, { roles: [] });
      const publicReader = setup.controller.forIdentity(setup.controller.mint(publicClaims), { identity: setup.input.identity, namespace: "/alpha" });
      assert.deepEqual(publicReader.get(), { flag: 1 });
      assert.throws(() => publicReader.validate(), { code: "FORBIDDEN" });
      const claims = principal(setup.input); claims.grants[0].sensitive = true;
      const sensitive = setup.controller.forIdentity(setup.controller.mint(claims), { identity: setup.input.identity, namespace: "/alpha" });
      if (policy.visibility === "internal") assert.throws(() => sensitive.validate(), { code: "FORBIDDEN" });
      else {
        assert.equal(sensitive.validate().validation.valid, false);
        assert.doesNotMatch(JSON.stringify(sensitive.validate()), /PRIVATE-invalid/);
      }
      assert.equal(setup.provider.loads, 1);
    } finally { await setup.root.dispose(); }
  }
  const setup = await fixture({ type: "object", properties: { flag: { type: "number" } } }, { flag: 1 });
  try {
    for (const operations of [["read"], ["inspect"], ["write"], []]) {
      const claims = principal(setup.input, { schemaPermissions: ["read", "register"] });
      claims.grants[0].operations = operations;
      const token = setup.controller.mint(claims);
      if (!operations.some((operation) => operation === "read" || operation === "inspect")) {
        assert.throws(() => setup.controller.forIdentity(token, { identity: setup.input.identity, namespace: "/alpha" }), { code: "FORBIDDEN" });
      } else {
        const port = setup.controller.forIdentity(token, { identity: setup.input.identity, namespace: "/alpha" });
        assert.throws(() => port.validate(), { code: "FORBIDDEN" });
      }
    }
    assert.equal(setup.port.validate().validation.valid, true);
  } finally { await setup.root.dispose(); }
});

test("validation follows live schema publication and checks expiry, revocation, nested host denial and disposal", async () => {
  let now = 0, deny = false, revoke;
  const setup = await fixture({ type: "object", properties: { flag: { type: "string" } } }, { flag: "public" }, {
    now: () => now,
    hostAuthority: {
      authorizeReadSync(_principal, request) {
        if (request.path === "/alpha/flag") { revoke?.(); if (deny) return "denied"; }
        return "allowed";
      },
      async authorizeWrite() { return "allowed"; },
    },
  });
  try {
    const claims = principal(setup.input, { expiresAt: 10 });
    const token = setup.controller.mint(claims), port = setup.controller.forIdentity(token, { identity: setup.input.identity, namespace: "/alpha" });
    assert.equal(port.validate().validation.valid, true);
    deny = true;
    assert.throws(() => port.validate(), { code: "FORBIDDEN" });
    assert.deepEqual(port.get(), {});
    assert.deepEqual(port.get([], { layer: "base" }), {});
    assert.throws(() => port.get(["flag"]), { code: "FORBIDDEN" });
    deny = false;
    now = 10; assert.throws(() => port.validate(), { code: "FORBIDDEN" }); now = 0;
    revoke = () => setup.controller.revoke(token);
    assert.throws(() => port.validate(), { code: "FORBIDDEN" }); revoke = undefined;
    const request = structuredClone(setup.input.schemas[0]); request.schema.properties.flag.type = "number";
    const schemas = setup.controller.forSchemas(setup.controller.mint(schemaClaims(setup.input)));
    assert.equal((await schemas.register(request)).success, true);
    assert.equal(setup.port.validate().validation.valid, false);
    request.schema.properties.flag["x-weaver"] = { sensitive: true };
    assert.equal((await schemas.register(request)).success, true);
    assert.throws(() => setup.port.validate(), { code: "FORBIDDEN" });
    assert.equal(setup.provider.loads, 1);
  } finally { await setup.root.dispose(); }
  const poisoned = { toString() { throw Error("must not reflect"); } };
  assert.throws(() => setup.port.validate(poisoned), { code: "DISPOSED" });
});

test("cold validation never implicitly loads a scope and invalid public composition returns validator errors", async () => {
  const scope = scopeOptions(), setup = await hosted(scope.input);
  try {
    const claims = principal(scope.input); claims.grants[0].identity.scopePath = scope.path1;
    const port = setup.controller.forIdentity(setup.controller.mint(claims), { identity: claims.grants[0].identity, namespace: "/alpha" });
    assert.throws(() => port.validate(), { code: "SCOPE_NOT_LOADED" });
    assert.equal(scope.first.loads + scope.second.loads, 0);
  } finally { await setup.root.dispose(); }
  const invalid = await fixture({ type: "object", properties: { count: { type: "number" } },
    anyOf: [{ type: "object", properties: { count: { type: "number", minimum: 10 } } }],
  }, { count: 2 });
  try { assert.equal(invalid.port.validate().validation.valid, false); }
  finally { await invalid.root.dispose(); }
});

test("invalid alternatives authorize conservative metadata without granting raw reads or leaking diagnostics", async () => {
  for (const keyword of ["anyOf", "oneOf"]) for (const policy of [undefined, { sensitive: true }, { visibility: "internal" }]) {
    const schema = { type: "object", properties: { count: { type: "number" } },
      [keyword]: [
        { type: "object", properties: { count: { type: "number", minimum: 10 } }, ...(policy ? { "x-weaver": policy } : {}) },
        { type: "object", properties: { count: { type: "number", maximum: 0 } } },
      ],
    };
    const setup = await fixture(schema, { count: 2 });
    try {
      assert.throws(() => setup.port.get(), { code: "FORBIDDEN" });
      assert.deepEqual(setup.port.inspect().effective, { state: "redacted" });
      if (policy) assert.throws(() => setup.port.validate(), { code: "FORBIDDEN" });
      else {
        const result = setup.port.validate();
        assert.equal(result.validation.valid, false);
        assert.ok(result.validation.errors.length > 0);
        assert.ok(result.validation.errors.every((error) => error.message === "Configuration does not satisfy the registered schema"));
      }
      assert.equal(setup.provider.loads, 1);
    } finally { await setup.root.dispose(); }
  }
});

test("installed ESM/CJS public identity ports validate raw state and read projected aggregates", async () => {
  await withConsumer(async (directory) => {
    const require = createRequire(join(directory, "package.json"));
    for (const cjs of [false, true]) {
      const service = cjs ? require("@weaver-conf/config-service")
        : await import(pathToFileURL(require.resolve("@weaver-conf/config-service").replace(/\.cjs$/, ".js")));
      const setup = await fixture({ type: "object", properties: { count: { type: "number" } } },
        { count: "wrong-type" }, {}, service.createConfigurationService);
      try {
        assert.deepEqual(setup.port.get(), { count: "wrong-type" });
        const result = setup.port.validate();
        assert.equal(result.validation.valid, false);
        assert.equal(result.revision, setup.port.revision);
        assert.equal(setup.provider.loads, 1);
        setup.controller.revoke(setup.token);
        assert.throws(() => setup.port.validate(), { code: "FORBIDDEN" });
      } finally { await setup.root.dispose(); }
    }
  });
});

test("inert reserved raw siblings remain private without disabling safe public aggregate reads", async () => {
  const raw = JSON.parse('{"safe":{"value":1},"opaque":{"constructor":{"secret":"PRIVATE"},"__proto__":{"secret":"PRIVATE"}}}');
  const setup = await fixture({ type: "object", additionalProperties: true }, raw);
  try {
    assert.equal(setup.port.get(["safe", "value"]), 1);
    assert.deepEqual(setup.port.get(), { safe: { value: 1 }, opaque: {} });
    assert.doesNotMatch(JSON.stringify(setup.port.inspect()), /PRIVATE|__proto__|constructor/);
    assert.throws(() => setup.port.validate(), { code: "FORBIDDEN" });
    assert.equal(raw.opaque.constructor.secret, "PRIVATE");
    assert.equal(Object.isFrozen(raw), false);
  } finally { await setup.root.dispose(); }
});
