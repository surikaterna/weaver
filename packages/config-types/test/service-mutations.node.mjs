import assert from "node:assert/strict";
import { test } from "node:test";
import { exerciseUnknownMutationReceipts } from "./domain-boundary-fixture.mjs";
import {
  configurationMutationCommandSchema as commandSchema,
  configurationMutationCommandsSchema as commandsSchema,
  configurationMutationResultSchema as resultSchema,
  configurationMutationAuthoritySchema as authoritySchema,
  configurationValueSchema as valueSchema,
} from "../dist/index.js";

const identity = { environment: "test", scopePath: [] };
const selection = { identity, namespace: "/alpha", layer: "base", path: "/alpha/value" };
const command = (value) => ({ ...selection, operation: "set", value });
const error = { code: "WRITE_ERROR", message: "Write rejected" };
const uncertain = { code: "WRITE_OUTCOME_UNKNOWN", message: "Outcome unknown" };
const revisions = [{ identity, revision: "one" }];

test("commands capture immutable ordinary JSON and explicit identity without freezing callers", () => {
  const shared = { nested: [null, true, 1, "雪"] };
  const value = { left: shared, right: shared };
  const input = [command(value)];
  const captured = commandsSchema.parse(input);
  assert.equal(captured[0].value.left, captured[0].value.right);
  assert.notEqual(captured[0].value.left, shared);
  assert.ok(Object.isFrozen(captured[0].value.left.nested));
  assert.ok(Object.isFrozen(captured[0].identity.scopePath));
  shared.nested[0] = "changed";
  input[0].path = "/elsewhere";
  assert.equal(captured[0].value.left.nested[0], null);
  assert.equal(captured[0].path, "/alpha/value");
  assert.equal(Object.isFrozen(value), false);
  for (const operation of ["set", "patch"])
    assert.ok(commandSchema.safeParse({ ...selection, operation, value: null }).success);
  assert.ok(commandSchema.safeParse({ ...selection, operation: "remove" }).success);
  assert.equal(commandSchema.safeParse({ ...selection, operation: "remove", value: null }).success, false);
});

test("commands reject executable/non-JSON/cyclic/sparse inputs without invoking accessors", () => {
  let calls = 0;
  const getter = { get hidden() { calls++; return "private"; } };
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol(), () => {}, new Date(), new Map(), [, 1], cyclic, getter])
    assert.equal(commandsSchema.safeParse([command(value)]).success, false);
  const list = []; Object.defineProperty(list, "0", { get() { calls++; return command(1); } });
  assert.equal(commandsSchema.safeParse(list).success, false);
  assert.equal(commandsSchema.safeParse([, command(1)]).success, false);
  assert.equal(commandsSchema.safeParse(new Array(4_294_967_295)).success, false);
  assert.equal(commandSchema.safeParse({ ...command(1), identity: { environment: "test", scopePath: new Array(4_294_967_295) } }).success, false);
  assert.equal(commandsSchema.safeParse([]).success, false);
  assert.equal(commandsSchema.safeParse([Object.create(command(1))]).success, false);
  for (const field of ["actor", "roles", "providerId", "trusted", "dedicated", "session"])
    assert.equal(commandSchema.safeParse({ ...command(1), [field]: true }).success, false);
  assert.equal(calls, 0);
});

test("JSON capture retains depth and DAG sharing without recursive native parsing", () => {
  let deep = null;
  for (let i = 0; i < 12_000; i++) deep = { child: deep };
  const parsed = valueSchema.parse(deep);
  let depth = 0, cursor = parsed;
  while (cursor !== null) { cursor = cursor.child; depth++; }
  assert.equal(depth, 12_000);
  const unsafe = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(valueSchema.safeParse(unsafe).success, false);
});

test("native result contracts distinguish rejected, committed prefix and unknown storage effects", () => {
  const committed = { index: 0, effect: "committed" };
  const rejected = { index: 1, effect: "rejected", error };
  const suffix = { index: 2, effect: "not-attempted" };
  const partial = { success: false, outcome: "partial", error, results: [committed, rejected, suffix], revisions };
  assert.ok(resultSchema.safeParse(partial).success);
  assert.ok(resultSchema.safeParse({ success: true, results: [committed], revisions }).success);
  assert.ok(resultSchema.safeParse({ success: false, outcome: "rejected", error, results: [] }).success);
  const unknown = { success: false, outcome: "unknown", error: uncertain, results: [committed, { index: 1, effect: "unknown", error: uncertain }] };
  assert.ok(resultSchema.safeParse(unknown).success);
  for (const input of [
    { ...unknown, revisions }, { ...unknown, error },
    { ...partial, outcome: "rejected" }, { ...partial, revisions: [] },
    { ...partial, results: [committed, { index: 1, effect: "not-attempted" }] },
    { success: true, results: [rejected], revisions },
    { success: true, results: [{ ...committed, index: 1 }], revisions },
    { success: true, results: [committed], revisions: [...revisions, ...revisions] },
    { success: true, layer: "base", revision: "old" },
  ]) assert.equal(resultSchema.safeParse(input).success, false);
});

test("mutation authority shape exposes only apply and does not execute it", () => {
  let calls = 0;
  const apply = () => { calls++; };
  assert.ok(authoritySchema.safeParse({ apply }).success);
  for (const alias of ["set", "remove", "executeBatch", "setMany"])
    assert.equal(authoritySchema.safeParse({ apply, [alias]: apply }).success, false);
  assert.equal(calls, 0);
});

for (const effects of [
  ["not-attempted", "unknown"],
  ["unknown", "not-attempted", "committed"],
  ["rejected", "unknown"],
]) test(`unknown result rejects impossible sequential receipts ${effects.join("/")}`, () => {
  const results = effects.map((effect, index) => ({ index, effect,
    ...(effect === "unknown" ? { error: uncertain } : effect === "rejected" ? { error } : {}) }));
  assert.equal(resultSchema.safeParse({ success: false, outcome: "unknown", error: uncertain, results }).success, false);
});

test("unknown receipt prefix rules retain grouped-flush uncertainty and positional indices", () => {
  exerciseUnknownMutationReceipts({ configurationMutationResultSchema: resultSchema });
});
