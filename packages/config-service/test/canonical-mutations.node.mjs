import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePartialConfiguration, validateEffectiveConfiguration } from "@weaver-conf/config-engine";
import { writable, WritableMemory, writableOptions, writer, writeBinding, commands } from "./fixtures/writable-memory.mjs";
import { principal } from "./fixtures/authority.mjs";
import { registration } from "./fixtures/memory.mjs";

test("command JSON and selectors are captured without getters or provider IO, terminal disposal wins first", async () => {
  const setup = await writable(); let getters = 0;
  try {
    const cycle = {}; cycle.self = cycle;
    for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(), cycle, new Array(2), { get private() { getters++; return 1; } }]) {
      const result = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/cfg", value }));
      assert.equal(result.error.code, "VALIDATION_ERROR");
    }
    assert.equal((await setup.mutations.apply([])).error.code, "VALIDATION_ERROR");
    const command = commands(setup.input, { operation: "remove", path: "/alpha/flag" })[0];
    Object.defineProperty(command, "path", { enumerable: true, get() { getters++; return "/alpha/flag"; } });
    assert.equal((await setup.mutations.apply([command])).error.code, "VALIDATION_ERROR");
    assert.equal(getters, 0); assert.equal(setup.provider.loads, 1); assert.equal(setup.provider.writes + setup.provider.removes, 0);
  } finally { await setup.root.dispose(); }
  const poisoned = new Proxy([], { getOwnPropertyDescriptor() { getters++; throw Error("reflect"); } });
  assert.equal((await setup.mutations.apply(poisoned)).error.code, "DISPOSED"); assert.equal(getters, 0);
});

test("explicit sensitive write grant plus role and host policy allows mutation, never public read disclosure", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]), records = [];
  const claims = principal(input); claims.grants[0].sensitive = true;
  const setup = await writable({ provider, input, claims, readerClaims: principal(input), host: { audit(record) { records.push(record); } } });
  try {
    const result = await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/hidden/a", value: 42 }));
    assert.equal(result.success, true); assert.equal(provider.entries.alpha.hidden.a, 42);
    assert.throws(() => setup.reader.get(["hidden", "a"]), { code: "FORBIDDEN" });
    assert.equal(records.find((item) => item.phase === "committed").request.sensitive, true);
    assert.ok(records.every((item) => item.commandIndex === 0 && item.request.mutation === "set"));
    assert.doesNotMatch(JSON.stringify(records), /42/);
    const unprivileged = setup.controller.forMutations(setup.controller.mint(principal(input)));
    assert.equal((await unprivileged.apply(commands(input, { operation: "set", path: "/alpha/hidden/a", value: 43 }))).error.code, "FORBIDDEN");
    assert.equal(provider.writes, 1);
  } finally { await setup.root.dispose(); }
});

test("parent replacement cannot bypass old branch restrictions, while patch ignores unchanged protected siblings", async () => {
  const provider = new WritableMemory("p", "base", { alpha: { kind: "private", locked: "retained", count: 1 } });
  const branch = (kind, restricted) => ({ type: "object", additionalProperties: true, properties: {
    kind: { type: "string", const: kind }, locked: { type: "string", ...(restricted ? { "x-weaver": { writeRestriction: ["other"] } } : {}) }, count: { type: "number" },
  } });
  const input = writableOptions([provider]); input.schemas = [registration("east", "alpha", { type: "object", additionalProperties: true, oneOf: [branch("private", true), branch("public", false)] })];
  const setup = await writable({ provider, input });
  try {
    const patch = await setup.mutations.apply(commands(input, { operation: "patch", path: "/alpha/count", value: 2 }));
    assert.equal(patch.success, true, JSON.stringify(patch)); assert.equal(provider.entries.alpha.locked, "retained");
    const result = await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha", value: { kind: "public", count: 3 } }));
    assert.equal(result.error.code, "POLICY_VIOLATION"); assert.equal(provider.writes, 1);
    assert.deepEqual(provider.entries.alpha, { kind: "private", locked: "retained", count: 2 });
  } finally { await setup.root.dispose(); }
});

test("all descendant host approvals precede dispatch and ordinary JSON members use only canonical ancestor authority", async () => {
  const provider = new WritableMemory("p", "base", { alpha: {} }), input = writableOptions([provider]);
  input.schemas = [registration("east", "alpha", { type: "object", additionalProperties: true })];
  const paths = []; let denied = true;
  const setup = await writable({ provider, input, host: { hostAuthority: {
    authorizeReadSync: () => "allowed", async authorizeWrite(_principal, request) { paths.push(request.path); return denied && request.path === "/alpha/nested/blocked" ? "denied" : "allowed"; },
  } } });
  try {
    assert.equal((await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha", value: { nested: { blocked: 1 } } }))).error.code, "FORBIDDEN");
    assert.equal(provider.writes, 0); assert.ok(paths.includes("/alpha/nested/blocked"));
    denied = false;
    const value = { "literal.dot": [null, { "a/b": true, "[brackets]": "雪" }], nested: { deeper: { arbitrary: false } } };
    assert.equal((await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha", value }))).success, true);
    assert.deepEqual(setup.reader.get(), value);
    provider.entries.alpha.nested.deeper.arbitrary = "outside authority";
    assert.equal(setup.reader.get(["nested", "deeper", "arbitrary"]), false);
  } finally { await setup.root.dispose(); }
});

test("mixed ready scopes share one generation without returning revisions of hidden cached identities", async () => {
  const base = new WritableMemory(), one = new WritableMemory("one", "scope", {}), two = new WritableMemory("two", "scope", {});
  const a = [{ scopeId: "area", value: "a" }], b = [{ scopeId: "area", value: "b" }];
  const input = writableOptions([base, one, two]);
  input.layers = [{ kind: "fixed", layer: "base", providerIds: [base.id] }, { kind: "scope", layer: "scope", providerIds: [one.id, two.id] }];
  input.providers = [writeBinding(base), writeBinding(one, { scopePath: a }), writeBinding(two, { scopePath: b })];
  const claims = principal(input); claims.grants.push(...[a, b].map((scopePath) => ({ ...claims.grants[0], identity: { environment: "east", scopePath } })));
  const setup = await writable({ provider: base, input, claims, host: { writers: [writer(base), writer(one), writer(two)] } });
  try {
    const queries = [a, b].map((scopePath) => setup.controller.forIdentity(setup.token, { identity: { environment: "east", scopePath }, namespace: "/alpha" }));
    for (const query of queries) await query.prepare();
    const hiddenRevision = queries[1].revision;
    const result = await setup.mutations.apply(commands(input,
      { operation: "set", path: "/alpha/flag", value: "shared" },
      { operation: "set", path: "/alpha/flag", value: "one", layer: "scope", identity: queries[0].selection.identity }));
    assert.equal(result.success, true); assert.equal(result.revisions.length, 2);
    assert.deepEqual(result.revisions.map((item) => item.identity.scopePath), [[], a]);
    assert.equal(queries[0].get(["flag"]), "one"); assert.equal(queries[1].get(["flag"]), "shared");
    assert.notEqual(queries[1].revision, hiddenRevision); assert.equal(queries[0].revision, queries[1].revision);
  } finally { await setup.root.dispose(); }
});

test("patch copies opaque own reserved siblings without granting authority to mutate or reveal them", async () => {
  const raw = JSON.parse('{"alpha":{"safe":1,"opaque":{"constructor":{"private":true},"__proto__":{"private":true}}}}');
  const provider = new WritableMemory("p", "base", raw), input = writableOptions([provider]);
  input.schemas = [registration("east", "alpha", { type: "object", additionalProperties: true })];
  const setup = await writable({ provider, input });
  try {
    const result = await setup.mutations.apply(commands(input, { operation: "patch", path: "/alpha/safe", value: 2 }));
    assert.equal(result.success, true); assert.deepEqual(provider.entries.alpha.opaque, raw.alpha.opaque);
    assert.deepEqual(setup.reader.get(), { safe: 2, opaque: {} });
    assert.equal(raw.alpha.safe, 1); assert.equal(Object.isFrozen(raw), false);
  } finally { await setup.root.dispose(); }
});

test("native apply accepts public composition, pattern, schema wildcard, numeric-object and nullable replacements", async () => {
  const branch = (kind) => ({ type: "object", additionalProperties: true, required: ["kind"], properties: { kind: { type: "string", const: kind }, value: { type: "number" } } });
  const cases = [
    [{ type: "object", additionalProperties: true, anyOf: [branch("a"), branch("b")] }, { kind: "a", value: 2 }],
    [{ type: "object", additionalProperties: true, oneOf: [branch("a"), branch("b")] }, { kind: "b", value: 3 }],
    [{ type: "object", additionalProperties: true, allOf: [{ type: "object", additionalProperties: true, properties: { count: { type: "number", minimum: 1 } } }] }, { count: 2 }],
    [{ type: "object", additionalProperties: true, not: { type: "object", additionalProperties: true, properties: { good: { type: "boolean", const: false } } } }, { good: true }],
    [{ type: "object", additionalProperties: false, patternProperties: { "^x": { type: "number" } } }, { xCount: 4 }],
    [{ type: "object", additionalProperties: { type: "number" } }, { extra: 5 }],
    [{ type: "object", properties: { "0": { type: "string" } } }, { "0": "zero" }],
    [{ type: ["object", "null"], additionalProperties: true }, null],
  ];
  for (const [schema, value] of cases) {
    const provider = new WritableMemory("p", "base", { alpha: {} }), input = writableOptions([provider]);
    input.schemas = [registration("east", "alpha", { type: "object", properties: { cfg: schema } })];
    const setup = await writable({ provider, input });
    try {
      const result = await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/cfg", value }));
      assert.equal(result.success, true, JSON.stringify({ schema, result }));
      assert.deepEqual(setup.reader.get(["cfg"]), value);
      if (schema.not) {
        const writes = provider.writes;
        assert.equal((await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/cfg", value: { good: false } }))).error.code, "VALIDATION_ERROR");
        assert.equal(provider.writes, writes);
      }
      if (value && Object.hasOwn(value, "0")) {
        assert.equal((await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/cfg/0", value: "changed" }))).success, true);
        assert.equal(setup.reader.get(["cfg", "0"]), "changed");
      }
    } finally { await setup.root.dispose(); }
  }
});

test("child-only grants cannot replace an effective atomic ancestor from a lower layer", async () => {
  const base = new WritableMemory("base", "base", { alpha: { cfg: "lower-atomic" } });
  const upper = new WritableMemory("upper", "upper", {}), input = writableOptions([base, upper]);
  input.schemas = [registration("east", "alpha", { type: "object", properties: {
    cfg: { type: ["object", "string"], properties: { a: { type: "number" } } },
  } })];
  const claims = principal(input); claims.grants[0].namespace = "/alpha/cfg/a";
  const setup = await writable({ provider: upper, input, claims, readerClaims: principal(input) });
  try {
    const result = await setup.mutations.apply(commands(input, { namespace: "/alpha/cfg/a", layer: "upper", operation: "set", path: "/alpha/cfg/a", value: 2 }));
    assert.equal(result.error?.code, "FORBIDDEN"); assert.equal(upper.writes, 0);
    const broad = setup.controller.forMutations(setup.controller.mint(principal(input)));
    assert.equal((await broad.apply(commands(input, { layer: "upper", operation: "set", path: "/alpha/cfg/a", value: 2 }))).success, true);
    assert.equal(base.entries.alpha.cfg, "lower-atomic"); assert.deepEqual(upper.entries.alpha.cfg, { a: 2 });
  } finally { await setup.root.dispose(); }
});

async function arrayAncestorFixture({ lower = [1, 2], upperValue, missing = false, namespace = "/alpha/cfg/a" } = {}) {
  const base = new WritableMemory("base", "base", { alpha: missing ? {} : { cfg: lower } });
  const upper = new WritableMemory("upper", "upper", upperValue === undefined ? {} : { alpha: { cfg: upperValue } });
  const input = writableOptions([base, upper]), paths = [];
  input.schemas = [registration("east", "alpha", { type: "object", properties: {
    cfg: { type: ["object", "array"], properties: { a: { type: "number" }, "0": { type: "number" } }, items: { type: "number" } },
  } })];
  const claims = principal(input); claims.grants[0].namespace = namespace;
  const control = { denyParent: false };
  const setup = await writable({ provider: upper, input, claims, readerClaims: principal(input), host: {
    writers: [writer(base, { flush: "required" }), writer(upper, { flush: "required" })],
    hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite(_principal, request) {
      paths.push(request.path); return control.denyParent && request.path === "/alpha/cfg" ? "denied" : "allowed";
    } },
  } });
  return { ...setup, base, upper, paths, control, namespace };
}

test("effective fallback arrays reject all generic child traversal before host approval or storage effects", async () => {
  for (const namespace of ["/alpha/cfg/a", "/alpha"]) {
    const setup = await arrayAncestorFixture({ namespace });
    try {
      const revision = setup.reader.revision;
      for (const operation of ["set", "remove"]) {
        const result = await setup.mutations.apply(commands(setup.input, { namespace, layer: "upper", operation,
          path: "/alpha/cfg/a", ...(operation === "set" ? { value: 9 } : {}) }));
        assert.equal(result.error?.code, "UNSUPPORTED_OPERATION", JSON.stringify(result));
        assert.deepEqual(result.results.map((receipt) => receipt.effect), ["rejected"]);
      }
      assert.deepEqual(setup.paths, []);
      assert.equal(setup.reader.revision, revision);
      assert.deepEqual(setup.base.entries.alpha.cfg, [1, 2]); assert.deepEqual(setup.upper.entries, {});
      for (const provider of [setup.base, setup.upper]) {
        assert.equal(provider.loads, 1); assert.equal(provider.writes + provider.removes + provider.flushes, 0);
      }
    } finally { await setup.root.dispose(); }
  }
});

test("whole-array replacement requires the actual parent host approval and remains supported when allowed", async () => {
  const setup = await arrayAncestorFixture({ namespace: "/alpha" });
  try {
    setup.control.denyParent = true;
    const list = commands(setup.input, { layer: "upper", operation: "set", path: "/alpha/cfg", value: { a: 9 } });
    assert.equal((await setup.mutations.apply(list)).error.code, "FORBIDDEN");
    assert.deepEqual(setup.paths, ["/alpha/cfg"]);
    assert.equal(setup.upper.writes + setup.upper.flushes, 0);
    setup.control.denyParent = false;
    assert.equal((await setup.mutations.apply(list)).success, true);
    assert.deepEqual(setup.upper.entries.alpha.cfg, { a: 9 }); assert.deepEqual(setup.base.entries.alpha.cfg, [1, 2]);
    assert.equal(setup.upper.writes, 1); assert.equal(setup.upper.flushes, 1);
  } finally { await setup.root.dispose(); }
});

test("array rejection uses every draft prefix, including a previous command on another binding", async () => {
  for (const layer of ["base", "upper"]) {
    const setup = await arrayAncestorFixture({ namespace: "/alpha" });
    try {
      const result = await setup.mutations.apply(commands(setup.input,
        { layer, operation: "set", path: "/alpha/cfg", value: [5, 6] },
        { layer: "upper", operation: "set", path: "/alpha/cfg/a", value: 9 }));
      assert.equal(result.error?.code, "UNSUPPORTED_OPERATION");
      assert.deepEqual(result.results.map((receipt) => receipt.effect), ["not-attempted", "rejected"]);
      for (const provider of [setup.base, setup.upper]) assert.equal(provider.writes + provider.removes + provider.flushes, 0);
      assert.deepEqual(setup.base.entries.alpha.cfg, [1, 2]); assert.deepEqual(setup.upper.entries, {});
    } finally { await setup.root.dispose(); }
  }
});

test("absent object members and concrete numeric object keys retain child-scoped authority", async () => {
  for (const [lower, key, missing] of [[{}, "a"], [{ "0": 1 }, "0"], [undefined, "a", true]]) {
    const namespace = `/alpha/cfg/${key}`, setup = await arrayAncestorFixture({ lower, missing, namespace });
    try {
      const result = await setup.mutations.apply(commands(setup.input, { namespace, layer: "upper", operation: "set", path: namespace, value: 9 }));
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(setup.paths, [namespace]); assert.deepEqual(setup.upper.entries.alpha.cfg, { [key]: 9 });
    } finally { await setup.root.dispose(); }
  }
});

test("dedicated array patch retains unchanged siblings under an exact element grant", async () => {
  const namespace = "/alpha/cfg/0", setup = await arrayAncestorFixture({ upperValue: [3, 4], namespace });
  try {
    const result = await setup.mutations.apply(commands(setup.input, { namespace, layer: "upper", operation: "patch", path: namespace, value: 9 }));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(setup.paths, [namespace]); assert.deepEqual(setup.upper.entries.alpha.cfg, [9, 4]);
    assert.deepEqual(setup.base.entries.alpha.cfg, [1, 2]); assert.equal(setup.upper.writes, 1); assert.equal(setup.upper.flushes, 1);
  } finally { await setup.root.dispose(); }
});

for (const targetKind of ["object", "array"]) test(`dedicated patch changing a fallback container to ${targetKind} requires ancestor grant and host approval`, async () => {
  const old = targetKind === "object" ? { kind: "array", cfg: [1, 2] } : { kind: "object", cfg: { a: 1 } };
  const base = new WritableMemory("base", "base", { alpha: old });
  const upper = new WritableMemory("upper", "upper", { alpha: { kind: targetKind } }), input = writableOptions([base, upper]);
  const object = { type: "object", properties: { a: { type: "number" } } }, array = { type: "array", items: { type: "number" } };
  input.schemas = [registration("east", "alpha", { type: "object", additionalProperties: true,
    oneOf: [object, array].map((cfg) => ({ type: "object", additionalProperties: true, required: ["kind"],
      properties: { kind: { type: "string", const: cfg.type }, cfg } })),
  })];
  const namespace = `/alpha/cfg/${targetKind === "object" ? "a" : "0"}`, claims = principal(input); claims.grants[0].namespace = namespace;
  const paths = []; let denyParent = false;
  const setup = await writable({ provider: upper, input, claims, readerClaims: principal(input), host: {
    writers: [writer(upper, { flush: "required" })],
    hostAuthority: { authorizeReadSync: () => "allowed", async authorizeWrite(_principal, request) {
      paths.push(request.path); return denyParent && request.path === "/alpha/cfg" ? "denied" : "allowed";
    } },
  } });
  try {
    const command = { layer: "upper", operation: "patch", path: namespace, value: 9 };
    assert.equal((await setup.mutations.apply(commands(input, { ...command, namespace }))).error?.code, "FORBIDDEN");
    assert.equal(upper.writes + upper.flushes, 0);
    const broad = setup.controller.forMutations(setup.controller.mint(principal(input)));
    paths.length = 0; denyParent = true;
    assert.equal((await broad.apply(commands(input, command))).error?.code, "FORBIDDEN");
    assert.ok(paths.includes("/alpha/cfg")); assert.equal(upper.writes + upper.flushes, 0);
    denyParent = false;
    const result = await broad.apply(commands(input, command));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(upper.entries.alpha, { kind: targetKind, cfg: targetKind === "object" ? { a: 9 } : [9] });
    assert.deepEqual(base.entries.alpha, old);
    assert.equal(upper.writes, 1); assert.equal(upper.flushes, 1);
  } finally { await setup.root.dispose(); }
});

async function unionPayloadFixture(before, additionalProperties, extra = {}) {
  const provider = new WritableMemory("p", "base", { alpha: before === undefined ? {} : { cfg: before } });
  const input = writableOptions([provider]);
  const cfg = { type: ["object", "array", "null"], properties: { a: { type: "number" }, "0": { type: "number" } },
    items: { type: "number" }, ...(additionalProperties === undefined ? {} : { additionalProperties }), ...extra };
  const schema = { type: "object", properties: { cfg } };
  input.schemas = [registration("east", "alpha", schema)];
  const setup = await writable({ provider, input, host: { writers: [writer(provider, { flush: "required" })] } });
  return { ...setup, schema };
}

test("public whole-value union replacement agrees with canonical engine for object/array/null transitions", async () => {
  for (const type of [["object", "array"], ["object", "array", "null"]]) {
    const values = (items) => items.filter((value) => value !== null || type.includes("null"));
    for (const before of values([{}, { a: 1 }, { "0": 1 }, [], [1], [1, 2], null, undefined])) {
      for (const value of values([[], [5], [5, 6], { a: 9 }, { "0": 9 }, null])) {
        await assertUnionReplacement(type, before, value);
      }
    }
  }
});

async function assertUnionReplacement(type, before, value) {
  const setup = await unionPayloadFixture(before, undefined, { type });
  try {
    const candidate = { cfg: value };
    assert.equal(validatePartialConfiguration(setup.schema, candidate).valid, true);
    assert.equal(validateEffectiveConfiguration(setup.schema, candidate).valid, true);
    const revision = setup.reader.revision;
    const result = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/cfg", value }));
    assert.equal(result.success, true, JSON.stringify({ before, value, result }));
    assert.deepEqual(result.results.map((item) => item.effect), ["committed"]);
    assert.deepEqual(setup.provider.entries.alpha.cfg, value); assert.deepEqual(setup.reader.get(["cfg"]), value);
    assert.notEqual(setup.reader.revision, revision); assert.equal(result.revisions[0].revision, setup.reader.revision);
    assert.equal(setup.provider.writes, 1); assert.equal(setup.provider.flushes, 1);
  } finally { await setup.root.dispose(); }
}

test("whole-value array item type violations reject before mutation even with explicit object wildcard", async () => {
  for (const additionalProperties of [false, true]) {
    const setup = await unionPayloadFixture({}, additionalProperties);
    try {
      const revision = setup.reader.revision;
      for (const value of [[5, "invalid"], [false], [null], [{ a: 1 }], [[1]]]) {
        assert.equal(validatePartialConfiguration(setup.schema, { cfg: value }).valid, false);
        assert.equal(validateEffectiveConfiguration(setup.schema, { cfg: value }).valid, false);
        const result = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/cfg", value }));
        assert.equal(result.error?.code, "VALIDATION_ERROR", JSON.stringify({ additionalProperties, value, result }));
        assert.equal(setup.reader.revision, revision); assert.deepEqual(setup.provider.entries.alpha.cfg, {});
        assert.equal(setup.provider.writes + setup.provider.removes + setup.provider.flushes, 0);
      }
    } finally { await setup.root.dispose(); }
  }
});

test("ordered whole array replacement then index patch stages valid prefixes without enabling generic array traversal", async () => {
  const setup = await unionPayloadFixture({});
  try {
    const revision = setup.reader.revision;
    const replace = { operation: "set", path: "/alpha/cfg", value: [5, 6], ifRevision: revision };
    const denied = await setup.mutations.apply(commands(setup.input, replace, { operation: "set", path: "/alpha/cfg/a", value: 9 }));
    assert.equal(denied.error?.code, "UNSUPPORTED_OPERATION");
    assert.deepEqual(denied.results.map((item) => item.effect), ["not-attempted", "rejected"]);
    assert.equal(setup.provider.writes + setup.provider.flushes, 0);
    const result = await setup.mutations.apply(commands(setup.input, replace, { operation: "patch", path: "/alpha/cfg/1", value: 9, ifRevision: revision }));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(setup.reader.get(["cfg"]), [5, 9]); assert.deepEqual(setup.provider.entries.alpha.cfg, [5, 9]);
    assert.equal(setup.provider.writes, 2); assert.equal(setup.provider.flushes, 1);
  } finally { await setup.root.dispose(); }
});

test("payload replacement still applies before-state policy to destructively removed object members", async () => {
  const setup = await unionPayloadFixture({ a: 1 }, false, { properties: {
    a: { type: "number", "x-weaver": { writeRestriction: ["other"] } }, "0": { type: "number" },
  } });
  try {
    const result = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/cfg", value: [5, 6] }));
    assert.equal(result.error?.code, "POLICY_VIOLATION");
    assert.equal(setup.provider.writes + setup.provider.flushes, 0); assert.deepEqual(setup.provider.entries.alpha.cfg, { a: 1 });
  } finally { await setup.root.dispose(); }
});

test("explicit wildcard JSON replacements retain deep literals while nested structured array items remain declared", async () => {
  const json = { type: ["object", "array", "null"], additionalProperties: true };
  for (const value of [[null, { "literal.dot": { "雪": [true, 2] } }], { nested: [null, [1, { value: false }]] }]) {
    const setup = await unionPayloadFixture({}, true, { items: json });
    try {
      const result = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/cfg", value }));
      assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(setup.reader.get(["cfg"]), value);
    } finally { await setup.root.dispose(); }
  }
  const member = { type: ["object", "array", "null"], properties: { a: { type: "number" } }, items: { type: "number" } };
  const setup = await unionPayloadFixture({ group: { a: 1 } }, false, { properties: { group: member }, items: member });
  try {
    const value = [[5, 6], { a: 9 }, null];
    const result = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/cfg", value }));
    assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(setup.reader.get(["cfg"]), value);
  } finally { await setup.root.dispose(); }
});

test("whole lower-layer union payload is admitted independently of a differently shaped effective overlay", async () => {
  const base = new WritableMemory("base", "base", { alpha: { cfg: { group: { a: 1 } } } });
  const overlay = new WritableMemory("overlay", "overlay", { alpha: { cfg: { group: { a: 2 } } } });
  const input = writableOptions([base, overlay]);
  const member = { type: ["object", "array", "null"], properties: { a: { type: "number" } }, items: { type: "number" }, oneOf: [
    { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
    { type: "array", items: { type: "number" } }, { type: "null" },
  ] };
  input.schemas = [registration("east", "alpha", { type: "object", properties: {
    cfg: { type: ["object", "array"], properties: { group: member }, items: member },
  } })];
  const setup = await writable({ provider: base, input });
  try {
    const value = [[5, 6], { a: 9 }, null];
    const result = await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/cfg", value }));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(base.entries.alpha.cfg, value); assert.equal(base.writes, 1);
    assert.deepEqual(setup.reader.get(["cfg"], { layer: "base" }), value);
    assert.deepEqual(setup.reader.get(["cfg"]), { group: { a: 2 } });
    assert.equal(overlay.writes + overlay.removes + overlay.flushes, 0);
  } finally { await setup.root.dispose(); }
});

test("partial record payload keeps the effective discriminator needed for composed member declarations", async () => {
  const base = new WritableMemory("base", "base", { alpha: { cfg: { kind: "count" } } });
  const upper = new WritableMemory("upper", "upper", {}), input = writableOptions([base, upper]);
  const branch = (kind, type) => ({ type: "object", required: ["kind", "value"], properties: {
    kind: { type: "string", const: kind }, value: { type },
  }, additionalProperties: false });
  const schema = { type: "object", properties: { cfg: { type: "object", properties: {
    kind: { type: "string" }, value: { type: ["string", "number"] },
  }, anyOf: [branch("text", "string"), branch("count", "number")] } } };
  input.schemas = [registration("east", "alpha", schema)];
  const setup = await writable({ provider: upper, input });
  try {
    const value = { cfg: { value: 3 } };
    assert.equal(validatePartialConfiguration(schema, value).valid, true);
    assert.equal(validateEffectiveConfiguration(schema, { cfg: { kind: "count", value: 3 } }).valid, true);
    const result = await setup.mutations.apply(commands(input, { layer: "upper", operation: "set", path: "/alpha", value }));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(upper.entries.alpha, value);
    assert.deepEqual(setup.reader.get(["cfg"]), { kind: "count", value: 3 });
    assert.equal(base.writes, 0); assert.equal(upper.writes, 1);
  } finally { await setup.root.dispose(); }
});

async function composedArrayFixture(keyword, { restricted = false, constrained = false } = {}) {
  const branch = (key) => ({ type: "array", items: { type: "object", properties: {
    [key]: { type: "number", ...(restricted && key === "a" ? { "x-weaver": { writeRestriction: ["other"] } } : {}) },
  }, required: [key], additionalProperties: false } });
  const cfg = { type: "array", [keyword]: [branch("a"), branch("b")], ...(constrained ? {
    allOf: [{ type: "array", minItems: 1 }, { type: "array", maxItems: 2 }],
    not: { type: "array", minItems: 2 },
  } : {}) };
  const schema = { type: "object", properties: { cfg } };
  const base = new WritableMemory("base", "base", { alpha: { cfg: [{ a: 1 }] } });
  const upper = new WritableMemory("upper", "upper", { alpha: { cfg: [{ a: 3 }] } }), input = writableOptions([base, upper]);
  input.schemas = [registration("east", "alpha", schema)];
  const setup = await writable({ provider: base, input, host: { writers: [writer(base, { flush: "required" })] } });
  return { ...setup, base, upper, schema };
}

for (const keyword of ["anyOf", "oneOf"]) test(`atomic ${keyword} replacement selects the new lower array branch, not the effective overlay`, async () => {
  const setup = await composedArrayFixture(keyword);
  try {
    const value = [{ b: 2 }];
    assert.equal(validatePartialConfiguration(setup.schema, { cfg: value }).valid, true);
    assert.equal(validateEffectiveConfiguration(setup.schema, { cfg: [{ a: 3 }] }).valid, true);
    const result = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/cfg", value }));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(setup.base.entries.alpha.cfg, value); assert.deepEqual(setup.reader.get(["cfg"], { layer: "base" }), value);
    assert.deepEqual(setup.upper.entries.alpha.cfg, [{ a: 3 }]); assert.deepEqual(setup.reader.get(["cfg"]), [{ a: 3 }]);
    assert.equal(setup.base.writes, 1); assert.equal(setup.base.flushes, 1);
    assert.equal(setup.upper.writes + setup.upper.removes + setup.upper.flushes, 0);
    const revision = setup.reader.revision;
    const invalid = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/cfg", value: [{ b: "invalid" }] }));
    assert.equal(invalid.success, false); assert.equal(invalid.outcome, "rejected");
    assert.equal(setup.base.writes, 1); assert.equal(setup.base.flushes, 1); assert.equal(setup.reader.revision, revision);
    assert.equal(validateEffectiveConfiguration(setup.schema, { cfg: [] }).valid, keyword === "anyOf");
    const empty = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/cfg", value: [] }));
    assert.equal(empty.success, keyword === "anyOf");
    assert.equal(setup.base.writes, keyword === "anyOf" ? 2 : 1);
    assert.equal(setup.base.flushes, keyword === "anyOf" ? 2 : 1);
    assert.deepEqual(setup.reader.get(["cfg"]), [{ a: 3 }]);
  } finally { await setup.root.dispose(); }
});

for (const keyword of ["anyOf", "oneOf"]) test(`atomic ${keyword} replacement retains allOf/not constraints and all-prefix rejection`, async () => {
  const setup = await composedArrayFixture(keyword, { constrained: true });
  try {
    const first = { operation: "set", path: "/alpha/cfg", value: [{ b: 2 }] };
    for (const value of [[{ b: 2 }, { b: 3 }], [{ b: 2 }, { b: 3 }, { b: 4 }]]) {
      assert.equal(validatePartialConfiguration(setup.schema, { cfg: value }).valid, false);
      const result = await setup.mutations.apply(commands(setup.input, first, { operation: "set", path: "/alpha/cfg", value }));
      assert.equal(result.error?.code, "VALIDATION_ERROR");
      assert.deepEqual(result.results.map((item) => item.effect), ["not-attempted", "rejected"]);
      assert.equal(setup.base.writes + setup.base.removes + setup.base.flushes, 0);
      assert.deepEqual(setup.base.entries.alpha.cfg, [{ a: 1 }]);
    }
    assert.equal((await setup.mutations.apply(commands(setup.input, first))).success, true);
  } finally { await setup.root.dispose(); }
});

test("atomic array branch replacement retains protected old-branch policy even behind an overlay", async () => {
  const setup = await composedArrayFixture("anyOf", { restricted: true });
  try {
    const result = await setup.mutations.apply(commands(setup.input, { operation: "set", path: "/alpha/cfg", value: [{ b: 2 }] }));
    assert.equal(result.error?.code, "POLICY_VIOLATION");
    assert.equal(setup.base.writes + setup.base.removes + setup.base.flushes, 0);
    assert.deepEqual(setup.base.entries.alpha.cfg, [{ a: 1 }]); assert.deepEqual(setup.upper.entries.alpha.cfg, [{ a: 3 }]);
  } finally { await setup.root.dispose(); }
});
