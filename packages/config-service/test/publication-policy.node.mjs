import assert from "node:assert/strict";
import { test } from "node:test";
import { commands, writable, WritableMemory, writableOptions } from "./fixtures/writable-memory.mjs";
import { deferred } from "./fixtures/memory.mjs";
import { schemaClaims } from "./fixtures/live-registry.mjs";

test("real queued publication reclassified by schema delivers value-free invalidation, never historical secrets", async () => {
  const provider = new WritableMemory(), input = writableOptions([provider]);
  const entered = deferred(), release = deferred(), original = provider.write;
  provider.write = async function (key, value) { const result = await original.call(this, key, value); entered.resolve(); await release.promise; return result; };
  const { root, reader, mutations, controller } = await writable({ provider, input });
  const events = [], direct = [];
  try {
    reader.onChange([], event => events.push(event));
    reader.onChange(["flag"], event => direct.push(event));
    const changed = mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "NEW_SECRET" }));
    await entered.promise;
    const admin = controller.forSchemas(controller.mint(schemaClaims(input)));
    const request = structuredClone(input.schemas[0]);
    request.schema.properties.flag["x-weaver"] = { sensitive: true };
    const registered = admin.register(request);
    release.resolve();
    assert.equal((await changed).success, true); assert.equal((await registered).success, true);
    await Promise.resolve(); await Promise.resolve();
    assert.ok(events.length >= 1);
    for (const event of events) {
      assert.equal(event.kind, "invalidation");
      assert.equal("previous" in event, false); assert.equal("current" in event, false);
      assert.equal(event.revision, reader.revision);
    }
    assert.doesNotMatch(JSON.stringify(events), /SECRET|before/);
    assert.equal(direct.length, 0);
    assert.deepEqual(reader.get(), { cfg: { a: 1 } });
  } finally { release.resolve(); await root.dispose(); }
});

for (const retire of ["revoke", "reader", "root"]) test(`queued real mutation never calls ${retire}-retired observers`, async () => {
  const provider = new WritableMemory(), entered = deferred(), release = deferred(), write = provider.write;
  provider.write = async function (key, value) { const result = await write.call(this, key, value); entered.resolve(); await release.promise; return result; };
  const { root, reader, mutations, controller, token, input } = await writable({ provider });
  let calls = 0;
  try {
    reader.onChange([], () => calls++);
    const pending = mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "retired" }));
    await entered.promise;
    if (retire === "revoke") controller.revoke(token);
    else if (retire === "reader") reader.dispose();
    else void root.dispose();
    release.resolve(); assert.equal((await pending).success, true);
    await Promise.resolve(); assert.equal(calls, 0);
  } finally { release.resolve(); await root.dispose(); }
});
