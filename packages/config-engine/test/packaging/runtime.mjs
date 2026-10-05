import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function checkRuntime(engine, consumer) {
  const { isNodeError } = engine;
  let caught;
  try {
    await readFile(join(consumer, "nonexistent-file"));
  } catch (error) {
    caught = error;
  }
  const identity = caught;
  assert.ok(isNodeError(caught));
  assert.equal(caught, identity);
  assert.ok(caught instanceof Error);
  assert.equal(caught.code, "ENOENT");
  assert.equal(typeof caught.errno, "number");
  assert.equal(caught.path, join(consumer, "nonexistent-file"));
  assert.equal(caught.syscall, "open");
  assert.equal(typeof caught.name, "string");
  assert.equal(typeof caught.message, "string");
  assert.equal(typeof caught.stack, "string");
  const inherited = Object.create(Object.assign(new Error("inherited"), { code: "ENOENT" }));
  assert.ok(isNodeError(inherited));
  assert.ok(isNodeError(Object.assign(new Error(), { code: undefined, errno: undefined, path: undefined, syscall: undefined })));
  for (const errno of [NaN, Infinity, -Infinity, 0]) {
    assert.ok(isNodeError(Object.assign(new Error(), { code: "X", errno, dest: "other", address: "host", port: 80 })));
  }
  for (const value of [new Error(), {}, { code: "ENOENT" }, null, "error", 1]) assert.equal(isNodeError(value), false);
  for (const [field, values] of [["code", [1, null, {}]], ["errno", ["1", null, {}]], ["path", [1, null, {}]], ["syscall", [1, null, {}]]]) {
    for (const value of values) {
      assert.equal(isNodeError(Object.assign(new Error(), { code: "X", [field]: value })), false);
    }
  }
}
