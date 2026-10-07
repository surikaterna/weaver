import assert from "node:assert/strict";
import { test } from "node:test";
import { commands, writable, WritableMemory, writableOptions, writer } from "./fixtures/writable-memory.mjs";

test("host flush uses declared required hooks only, preserves generation and contains reentry", async () => {
  const provider = new WritableMemory(), other = new WritableMemory("other", "other", {});
  const input = writableOptions([provider, other]);
  const { root, reader, mutations } = await writable({ provider, input, host: { writers: [writer(provider, { flush: "required" })] } });
  try {
    const events = []; reader.onChange([], event => events.push(event));
    const revision = reader.revision;
    assert.equal((await root.flush()).ok, true);
    assert.equal(provider.flushes, 1); assert.equal(other.flushes, 0);
    assert.equal(reader.revision, revision); assert.equal(events.length, 0);
    const write = mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "queued" }));
    const flushed = root.flush();
    assert.equal((await write).success, true); assert.equal((await flushed).ok, true);
    assert.equal(provider.flushes, 3); assert.equal(events.length, 1);
  } finally { await root.dispose(); }
  assert.equal((await root.flush()).error.code, "DISPOSED");
});

test("failed flush attempts remaining hooks, fences without fabricated publication or retry", async () => {
  const first = new WritableMemory(), second = new WritableMemory("second", "second", {});
  first.flush = async () => { first.flushes++; throw Error("SECRET"); };
  const input = writableOptions([first, second]);
  const { root, reader } = await writable({ provider: first, input,
    host: { writers: [writer(first, { flush: "required" }), writer(second, { flush: "required" })] } });
  try {
    const revision = reader.revision;
    const result = await root.flush();
    assert.equal(result.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assert.equal(first.flushes, 1); assert.equal(second.flushes, 1);
    assert.equal(root.mode, "degraded"); assert.equal(reader.revision, revision);
    assert.equal((await root.flush()).error.code, "WRITE_UNAVAILABLE");
    assert.equal(first.flushes, 1); assert.equal(second.flushes, 1);
  } finally { await root.dispose(); }
});
