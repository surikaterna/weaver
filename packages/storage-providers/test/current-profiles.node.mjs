import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSystemStorageProvider } from "../src/fs-provider.ts";
import { createGitStorageProvider } from "../src/git-storage-provider.ts";
import { createGitManager } from "../src/git-manager.ts";
import { createInMemoryStorageProvider } from "../src/in-memory-provider.ts";
import { createMongoDBStorageProvider } from "../src/mongodb-storage-provider.ts";

async function profile(kind, run) {
  const directory = await mkdtemp(join(tmpdir(), "weaver-current-profile-"));
  const filePath = join(directory, "entries.json");
  const options = { id: kind, layer: "app", filePath, writable: true, authority: { environment: "test", initialize: true } };
  const manager = createGitManager({ localPath: directory, repoUrl: "unused", git: { async cwd() {}, async add() {}, async status() { return { staged: [] }; }, async push() { assert.fail("replication disabled"); } } });
  const create = () => kind === "fs" ? createFileSystemStorageProvider(options) : kind === "git" ? createGitStorageProvider({ ...options, filePath: "entries.json", gitManager: manager, replicate: false }) : createInMemoryStorageProvider({ id: kind, layer: "app", environment: "test" });
  const provider = create();
  const owner = await provider.authority.acquireWriter("explicit-new-target-initialization");
  await provider.authority.releaseWriter(owner);
  try { await run(provider, kind === "memory" ? () => provider : create, filePath); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

for (const kind of ["fs", "git", "memory"]) test(`${kind}: current envelope nested object write, replacement, remove, metadata and reload`, async () => profile(kind, async (provider, reload) => {
  assert.deepEqual((await provider.load()).entries, {});
  assert.equal((await provider.write("billing", { plan: "starter", limits: { seats: 5 } })).success, true);
  assert.equal((await provider.write("billing.plan", "pro")).success, true);
  assert.equal((await provider.write("billing.limits.seats", 10)).success, true);
  assert.deepEqual((await reload().load()).entries.billing, { plan: "pro", limits: { seats: 10 } });
  assert.equal((await provider.write("billing", { plan: "replacement" })).success, true);
  assert.deepEqual((await reload().load()).entries.billing, { plan: "replacement" });
  const inventory = { version: 1, revision: "0", contexts: {} };
  assert.equal((await provider.write("_weaver.scopeInventory", inventory)).success, true);
  assert.deepEqual((await reload().load()).entries._weaver, { scopeInventory: inventory });
  assert.equal((await provider.remove("billing.plan")).success, true);
  assert.deepEqual((await reload().load()).entries.billing, {});
  assert.equal((await provider.remove("billing")).success, true);
  assert.equal((await reload().load()).entries.billing, undefined);
}));

for (const kind of ["fs", "git", "memory"]) test(`${kind}: malformed path results preserve entries/revision`, async () => profile(kind, async (provider) => {
  const before = await provider.load();
  for (const key of ["__proto__.x", "constructor.x", "prototype.x", "a[", "a..b", "", "../etc/passwd", "foo/../../bar"]) {
    assert.equal((await provider.write(key, "bad")).error.code, "VALIDATION_ERROR");
    assert.equal((await provider.remove(key)).error.code, "VALIDATION_ERROR");
  }
  assert.deepEqual(await provider.load(), before);
}));

test("filesystem rejects missing/unversioned/corrupt storage and obsolete options without rewriting bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-format-refusal-"));
  const filePath = join(directory, "entries.json");
  const options = { id: "fs", layer: "app", filePath, authority: { environment: "test" }, writable: true };
  try {
    await assert.rejects(createFileSystemStorageProvider(options).load(), { code: "PROVIDER_CORRUPT" });
    for (const text of ['{"app":{"value":1}}', '{"_weaver":{"schemas":{}}}', '{"storageFormat":2,"entries":{}}', "not JSON"]) {
      await writeFile(filePath, text);
      await assert.rejects(createFileSystemStorageProvider(options).load(), { code: "PROVIDER_CORRUPT" });
      assert.equal(await readFile(filePath, "utf8"), text);
    }
    assert.throws(() => createFileSystemStorageProvider({ ...options, environmentOverlayPath: "old.json" }), { code: "UNSUPPORTED_AUTHORITY" });
    assert.throws(() => createFileSystemStorageProvider({ ...options, authority: undefined }), { code: "UNSUPPORTED_AUTHORITY" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("filesystem readonly writes reject without granting an invisible overlay or watcher", async () => profile("fs", async (_provider, _reload, filePath) => {
  const provider = createFileSystemStorageProvider({ id: "readonly", layer: "app", filePath, writable: false, authority: { environment: "test" } });
  const before = await provider.load();
  assert.equal((await provider.write("a", 1)).error.code, "READONLY");
  assert.equal((await provider.remove("a")).error.code, "READONLY");
  assert.throws(() => provider.onExternalChange(() => {}), { code: "UNSUPPORTED_AUTHORITY" });
  assert.deepEqual(await provider.load(), before);
}));

test("Mongo old root-key factory mode is removed before collection IO", () => {
  let io = 0;
  const collection = { find() { io++; }, watch() { io++; } };
  assert.throws(() => createMongoDBStorageProvider({ id: "old", layer: "app", collection, environment: "test" }), { code: "UNSUPPORTED_AUTHORITY" });
  assert.equal(io, 0);
});
