import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  canonicalConfigurationPathSchema as canonical,
  relativeConfigurationPathSchema as relative,
  configurationServiceIdentitySchema as identitySchema,
  configurationMutationCommandSchema as commandSchema,
  configurationMutationResultSchema as result,
  configurationInspectionValueSchema as value,
  hydratedConfigurationInspectionSchema as inspection,
  configurationReaderChangeSchema as event,
  configurationReaderSchema as reader,
  configurationServiceSchema as root,
  writeResultSchema,
} from "../dist/index.js";

const identity = { environment: "dev", scopePath: [
  { scopeId: "region", value: "eu:west" },
  { scopeId: "tenant", value: "a,b" },
] };
const path = "/example/literal.dot/🪄/e\u0301";
const error = (code) => ({ code, message: "failed" });
const selection = { identity, namespace: "/example", path, operation: "set", value: 1, layer: "user" };

test("literal path contracts retain codepoints and reject escapes", () => {
  assert.equal(canonical.parse(path), path);
  const segments = ["literal.dot", "🪄", "e\u0301", "%2F"];
  assert.deepEqual(relative.parse(segments), segments);
  assert.notEqual(canonical.parse("/é"), canonical.parse("/e\u0301"));
  for (const bad of ["/", "a", "/a/", "/a//b", "/.", "/a/..", "/a[b]", "/a/_weaver", "/__proto__", "/constructor", "/prototype"]) {
    assert.equal(canonical.safeParse(bad).success, false, bad);
  }
  assert.deepEqual(relative.parse([]), []);
  for (const bad of [[""], ["."], [".."], ["a/b"], ["[x]"], ["_weaver"], ["__proto__"], ["constructor"], ["prototype"]]) {
    assert.equal(relative.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("identity copies and freezes ordered scopes without new wire restrictions", () => {
  const parsed = identitySchema.parse(identity);
  assert.deepEqual(parsed, identity);
  assert.notEqual(parsed.scopePath, identity.scopePath);
  assert.notEqual(parsed.scopePath[0], identity.scopePath[0]);
  for (const part of [parsed, parsed.scopePath, ...parsed.scopePath]) assert.equal(Object.isFrozen(part), true);
  assert.throws(() => parsed.scopePath.reverse(), TypeError);
  assert.throws(() => { parsed.scopePath[0].value = "other"; }, TypeError);
  assert.equal(identitySchema.safeParse({ ...identity, scopePath: [identity.scopePath[0], identity.scopePath[0]] }).success, false);
});

test("strict boundaries reject getters, hidden/symbol keys and prototypes before reads", () => {
  let calls = 0;
  const accessor = { layer: "user" };
  Object.defineProperty(accessor, "ifRevision", { enumerable: true, get() { calls++; return "r"; } });
  const hidden = { layer: "user" };
  Object.defineProperty(hidden, "hidden", { value: true });
  const proto = Object.assign(Object.create({ polluted: true }), { layer: "user" });
  const reserved = JSON.parse('{"layer":"user","__proto__":{}}');
  for (const bad of [accessor, hidden, proto, reserved, { layer: "user", [Symbol()]: true }, { layer: "user", actor: "plugin" }]) {
    const command = Object.defineProperties({ ...selection }, Object.getOwnPropertyDescriptors(bad));
    if (Object.getPrototypeOf(bad) !== Object.prototype) Object.setPrototypeOf(command, Object.getPrototypeOf(bad));
    assert.equal(commandSchema.safeParse(command).success, false);
  }
  const nested = { environment: "dev", scopePath: [{ scopeId: "tenant", get value() { calls++; return "x"; } }] };
  assert.equal(identitySchema.safeParse(nested).success, false);
  assert.equal(calls, 0);
  for (const forbidden of ["roles", "environment", "scopePath", "session"]) {
    assert.equal(commandSchema.safeParse({ ...selection, [forbidden]: "x" }).success, false);
  }
});

test("write results narrow success and enforce error/outcome consistency", () => {
  const good = [
    { success: true, results: [{ index: 0, effect: "committed" }], revisions: [{ identity, revision: "r1" }] },
    { success: false, error: error("WRITE_ERROR"), outcome: "rejected", results: [{ index: 0, effect: "rejected", error: error("WRITE_ERROR") }] },
    { success: false, error: error("DISPOSED"), outcome: "rejected", results: [] },
    { success: false, error: error("WRITE_OUTCOME_UNKNOWN"), outcome: "unknown", results: [{ index: 0, effect: "unknown", error: error("WRITE_OUTCOME_UNKNOWN") }] },
  ];
  for (const item of good) assert.deepEqual(result.parse(item), item);
  const bad = [
    { success: true }, { success: true, layer: "user" }, { ...good[0], error: error("WRITE_ERROR") },
    { ...good[1], layer: "user" }, { ...good[1], revision: "r" },
    { ...good[1], outcome: "unknown" }, { ...good[3], outcome: "rejected" },
  ];
  for (const item of bad) assert.equal(result.safeParse(item).success, false);
  assert.equal(writeResultSchema.safeParse({ success: true }).success, true);
});

test("inspection/event states exclude redacted payloads and preserve provenance order", () => {
  for (const bad of [{ state: "redacted", value: "secret" }, { state: "missing", value: 1 }, { state: "value" }, { state: "value", value: undefined }]) {
    assert.equal(value.safeParse(bad).success, false);
  }
  const contributions = [
    { state: "value", value: 1, layer: "defaults", providerId: "b" },
    { state: "missing", layer: "scoped", providerId: "a" },
    { state: "redacted", layer: "session", providerId: "c" },
  ];
  const snapshot = { path, identity, revision: "r1", effective: { state: "redacted" }, contributions };
  assert.deepEqual(inspection.parse(snapshot), snapshot);
  assert.equal(inspection.safeParse({ ...snapshot, contributions: [contributions[0], contributions[0]] }).success, false);
  assert.equal(inspection.safeParse({ ...snapshot, effective: { state: "missing" }, effectiveLayer: "user" }).success, false);
  assert.equal(inspection.safeParse({ ...snapshot, contributions: [{ ...contributions[2], value: "secret" }] }).success, false);
  const change = { kind: "effective", path, selection: { identity, namespace: "/example" }, previousRevision: "r0", revision: "r1", previous: { state: "missing" }, current: { state: "value", value: 2 }, cause: "mutation", reloadBehavior: "hot" };
  assert.deepEqual(event.parse(change), change);
  assert.equal(event.safeParse({ ...change, current: { state: "redacted", value: "secret" } }).success, false);
});

test("executable schemas check shape only without invocation or leaked root", () => {
  let calls = 0;
  const fn = () => { calls++; };
  const ready = { selection: { identity, namespace: "/example" }, revision: "r", prepare: fn, get: fn, snapshot: fn, inspect: fn, validate: fn, onChange: fn, withScope: fn, forView: fn, dispose: fn };
  assert.equal(reader.safeParse(ready).success, true);
  const rootShape = { mode: "live", degradedProviders: [], restartState: { revision: "r1", pending: "none" }, acknowledgeRestart: fn, reloadProvider: fn, flush: fn, dispose: fn };
  assert.equal(root.safeParse(rootShape).success, true);
  for (const field of ["set", "remove", "apply"]) assert.equal(root.safeParse({ ...rootShape, [field]: fn }).success, false);
  for (const field of ["root", "client", "transport", "session", "set", "remove", "getWithDefault", "getAtLayer", "getNamespace"]) {
    assert.equal(reader.safeParse({ ...ready, [field]: fn }).success, false);
  }
  assert.equal(reader.safeParse({ ...ready, get: 1 }).success, false);
  assert.equal(calls, 0);
});

test("public emitted declarations enforce confined capabilities under strict TypeScript", () => {
  const checked = spawnSync("pnpm", ["exec", "tsc", "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "tests/fixtures/hydrated-service-contracts.ts"], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});
