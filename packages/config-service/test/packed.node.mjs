import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withConsumer } from "./fixtures/packed-consumer.mjs";
import { strictDeclarations } from "./fixtures/packed-declarations.mjs";
import { browserProof } from "./fixtures/packed-browser.mjs";
import { filesystemProof } from "./fixtures/packed-filesystem.mjs";
import { packedSessions } from "./fixtures/packed-sessions.mjs";

test("real packed public ESM/CJS root, strict NodeNext/Bundler, full browser graph and injected filesystem", async () => {
  await withConsumer(async (directory) => { await strictDeclarations(directory); await browserProof(directory); await filesystemProof(directory); await packedSessions(directory); });
});
test("consumer setup and callback failures preserve original errors and only clean allocated ownership", async () => {
  const parent = await mkdtemp(join(tmpdir(), "hydration-owned-"));
  try {
    await writeFile(join(parent, "sentinel"), "retain");
    const original = Error("original");
    for (const options of [{ execute() { throw original; } }, { write() { throw original; } }, { resolve() { throw original; } }]) {
      await assert.rejects(withConsumer(() => {}, { parent, ...options }), (error) => error === original);
      assert.deepEqual(await readdir(parent), ["sentinel"]);
    }
    await assert.rejects(withConsumer(() => { throw original; }, { parent }), (error) => error === original);
    assert.deepEqual(await readdir(parent), ["sentinel"]); assert.equal(await readFile(join(parent, "sentinel"), "utf8"), "retain");
  } finally { await rm(parent, { recursive: true, force: true }); }
});
