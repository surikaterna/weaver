import assert from "node:assert/strict";
import { test } from "node:test";
import { commands, writable, WritableMemory, writableOptions } from "./fixtures/writable-memory.mjs";

for (const behavior of ["hot", "rolling-restart", "restart-required"]) test(`effective ${behavior} changes latch and acknowledgement is revision bounded`, async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  input.schemas[0].schema.properties.flag["x-weaver"] = { reloadBehavior: behavior };
  const { root, reader, mutations } = await writable({ provider, input });
  try {
    const initial = root.restartState, events = [];
    reader.onChange(["flag"], event => events.push(event));
    assert.equal(initial.pending, "none");
    await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "new" }));
    await Promise.resolve();
    assert.equal(root.restartState.pending, behavior === "hot" ? "none" : behavior);
    assert.equal(events[0].reloadBehavior, behavior);
    assert.equal((await root.acknowledgeRestart(initial.revision)).error.code, "REVISION_CONFLICT");
    const current = root.restartState.revision;
    assert.equal((await root.acknowledgeRestart(current)).ok, true);
    assert.deepEqual(root.restartState, { revision: current, pending: "none" });
    assert.equal(events.length, 1); assert.equal(provider.flushes, 0);
    await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "before" }));
    assert.equal(root.restartState.pending, behavior === "hot" ? "none" : behavior);
  } finally { await root.dispose(); }
});

test("privileged restart latch cannot leak denied changed-branch severity into reader hints", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  input.schemas[0].schema.properties.hidden = { type: "string", "x-weaver": { sensitive: true, reloadBehavior: "restart-required" } };
  provider.entries.alpha.hidden = "before";
  const { root, reader } = await writable({ provider, input });
  try {
    const events = []; reader.onChange([], event => events.push(event));
    provider.entries.alpha.hidden = "SECRET"; provider.entries.alpha.flag = "hot";
    assert.equal((await root.reloadProvider(provider.id)).ok, true);
    assert.equal(root.restartState.pending, "restart-required");
    assert.equal(events.length, 1); assert.equal(events[0].reloadBehavior, "hot");
    assert.doesNotMatch(JSON.stringify(events), /SECRET|hidden/);
    assert.equal((await root.acknowledgeRestart(root.restartState.revision)).ok, true);
    provider.entries.alpha.hidden = "different";
    assert.equal((await root.reloadProvider(provider.id)).ok, true);
    assert.equal(root.restartState.pending, "restart-required"); assert.equal(events.length, 1);
  } finally { await root.dispose(); }
});
