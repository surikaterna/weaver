import assert from "node:assert/strict";
import { test } from "node:test";
import { commands, WritableMemory, writableOptions, writeBinding, writer } from "./fixtures/writable-memory.mjs";
import { sessionHost } from "./fixtures/session-host.mjs";
import { principal } from "./fixtures/authority.mjs";
import { viewSchema, registration } from "./fixtures/memory.mjs";

test("trusted emergency satisfies only session/change policy, never blocked/pipeline/visibility/schema admission", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  input.schemas[0].schema.properties = {
    ...input.schemas[0].schema.properties,
    flag: { type: "string", "x-weaver": { sessionMode: "restricted", changePolicy: "emergency-override" } },
    blocked: { type: "string", "x-weaver": { sessionMode: "blocked" } },
    pipeline: { type: "string", "x-weaver": { changePolicy: "full-pipeline" } },
    hidden: { type: "string", "x-weaver": { sensitive: true } },
    restricted: { type: "string", "x-weaver": { writeRestriction: ["other"] } },
  };
  const records = [];
  const s = await sessionHost({ provider, input, host: { audit(record) { records.push(record); } } });
  try {
    const normal = (await s.activate()).value, emergency = (await s.activate({ emergency: true })).value;
    const write = (id, path, value = "value") => s.mutations.apply(commands(input, { operation: "set", layer: "incident", sessionId: id, path, value }));
    assert.equal((await write(normal.id, "/alpha/flag")).error.code, "POLICY_VIOLATION");
    assert.equal((await write(emergency.id, "/alpha/flag")).success, true);
    assert.equal(s.reader.get(["flag"]), "value");
    for (const key of ["blocked", "pipeline", "hidden", "restricted", "undeclared"]) {
      assert.equal((await write(emergency.id, `/alpha/${key}`)).success, false, key);
    }
    assert.equal((await write(emergency.id, "/alpha/flag", 123)).success, false);
    assert.equal(s.provider.writes, 0);
    assert.equal(records.find((record) => record.request.operation === "session-activate" && record.request.sessionId === emergency.id).request.emergency, true);
    assert.equal(records.find((record) => record.phase === "committed" && record.request.operation === "write").request.sessionId, emergency.id);
    assert.equal(records.every((record) => record.principalId === s.claims.principalId), true);
  } finally { await s.root.dispose(); }
});

test("session patch/remove use the ordinary engine and mixed invalid batches have zero effects", async () => {
  const s = await sessionHost();
  try {
    const info = (await s.activate()).value;
    const session = (operation, path, value) => commands(s.input, { operation, path, layer: "incident", sessionId: info.id, ...(operation === "remove" ? {} : { value }) });
    assert.equal((await s.mutations.apply(session("patch", "/alpha/cfg/a", 7))).success, true);
    assert.equal(s.reader.get(["cfg", "a"]), 7);
    assert.equal((await s.mutations.apply(session("set", "/alpha/list", [1, 2]))).success, true);
    assert.deepEqual(s.reader.get(["list"]), [1, 2]);
    assert.equal((await s.mutations.apply(session("remove", "/alpha/cfg/a"))).success, true);
    assert.equal(s.reader.get(["cfg", "a"]), 1);
    const revision = s.reader.revision;
    const invalid = await s.mutations.apply([
      ...session("set", "/alpha/flag", "must not appear"),
      ...commands(s.input, { operation: "set", path: "/alpha/cfg/a", value: "wrong type" }),
    ]);
    assert.equal(invalid.success, false); assert.equal(s.provider.writes, 0);
    assert.equal(s.reader.get(["flag"]), "before"); assert.equal(s.reader.revision, revision);
  } finally { await s.root.dispose(); }
});

test("view sessions write compiled physical paths and never affect base or another view", async () => {
  const provider = new WritableMemory("disk", "base", { alpha: { flag: "base", instances: { one: { flag: "one" }, two: { flag: "two" } } } });
  const input = writableOptions([provider]); input.schemas = [registration("east", "alpha", viewSchema())];
  input.layers.push({ kind: "session", layer: "incident" });
  const claims = principal(input, { sessionPermissions: ["read", "activate", "extend", "deactivate"] });
  claims.grants.push({ ...claims.grants[0], views: ["one", "two"] });
  const s = await sessionHost({ provider, input, claims });
  try {
    const one = s.reader.forView("one"), two = s.reader.forView("two");
    await one.prepare(); await two.prepare();
    const info = (await s.activate({ viewId: "one" })).value;
    const result = await s.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", layer: "incident", sessionId: info.id, viewId: "one", value: "session one" }));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(one.get(["flag"]), "session one");
    assert.equal(two.get(["flag"]), "two"); assert.equal(s.reader.get(["flag"]), "base");
    assert.equal((await s.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", layer: "incident", sessionId: info.id, viewId: "two", value: "escape" }))).success, false);
    assert.equal((await s.root.reloadProvider(provider.id)).ok, true);
    assert.equal(one.get(["flag"]), "session one");
    await s.sessions.deactivate({ sessionId: info.id });
    assert.equal(one.get(["flag"]), "one"); assert.equal(two.get(["flag"]), "two");
    assert.equal(provider.writes, 0);
  } finally { await s.root.dispose(); }
});

test("exact ordered scope sessions neither inherit into siblings nor enumerate without complete grants", async () => {
  const base = new WritableMemory(), a = new WritableMemory("a", "scope", {}), b = new WritableMemory("b", "scope", {});
  const pathA = [{ scopeId: "tenant", value: "a:b" }], pathB = [{ scopeId: "tenant", value: "a" }];
  const input = writableOptions([base]);
  input.layers.push({ kind: "scope", layer: "scope", providerIds: ["a", "b"] }, { kind: "session", layer: "incident" });
  input.providers.push(writeBinding(a, { scopePath: pathA }), writeBinding(b, { scopePath: pathB }));
  const claims = principal(input, { sessionPermissions: ["read", "activate", "extend", "deactivate", "manage"] });
  claims.grants.push(...[pathA, pathB].map((scopePath) => ({ ...claims.grants[0], identity: { environment: "east", scopePath } })));
  const s = await sessionHost({ provider: base, input, claims });
  try {
    const identity = { environment: "east", scopePath: pathA };
    const created = await s.activate({ identity }); assert.equal(created.ok, true, JSON.stringify(created));
    const first = s.reader.withScope(pathA), second = s.reader.withScope(pathB);
    await first.prepare(); await second.prepare();
    assert.equal((await s.mutations.apply(commands(input, { identity, operation: "set", path: "/alpha/flag", layer: "incident", sessionId: created.value.id, value: "scope a" }))).success, true);
    assert.equal(first.get(["flag"]), "scope a"); assert.equal(second.get(["flag"]), "before"); assert.equal(s.reader.get(["flag"]), "before");
    const baseOnly = s.controller.mint({ ...claims, grants: [claims.grants[0]] });
    assert.equal(s.controller.forSessions(baseOnly).get(created.value.id), null);
    assert.deepEqual(s.controller.forSessions(baseOnly).list(), []);
    assert.equal((await s.activate({ identity: { ...identity, environment: "west" } })).ok, false);
  } finally { await s.root.dispose(); }
});

test("session slot rank is configured, shadowed updates notify layer only and restart follows effective fallback", async () => {
  const base = new WritableMemory(), top = new WritableMemory("top", "top", { alpha: { flag: "top" } });
  const input = writableOptions([base, top]);
  input.layers.splice(1, 0, { kind: "session", layer: "incident" });
  input.schemas[0].schema.properties.flag["x-weaver"] = { reloadBehavior: "restart-required" };
  const s = await sessionHost({ provider: base, input, host: { writers: [writer(base), writer(top)] } });
  try {
    const events = [], layers = []; s.reader.onChange(["flag"], (e) => events.push(e));
    s.reader.onChange(["flag"], (e) => layers.push(e), { layer: "incident" });
    const info = (await s.activate()).value;
    assert.equal((await s.mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", layer: "incident", sessionId: info.id, value: "shadowed" }))).success, true);
    assert.equal(s.reader.get(["flag"]), "top"); assert.equal(events.length, 0);
    assert.equal(s.root.restartState.pending, "none"); assert.ok(layers.length > 0);
    await s.mutations.apply(commands(input, { operation: "remove", path: "/alpha/flag", layer: "top" }));
    assert.equal(s.reader.get(["flag"]), "shadowed");
    await s.root.acknowledgeRestart(s.root.restartState.revision);
    await s.sessions.deactivate({ sessionId: info.id });
    assert.equal(s.reader.get(["flag"]), "before"); assert.equal(s.root.restartState.pending, "restart-required");
  } finally { await s.root.dispose(); }
});
