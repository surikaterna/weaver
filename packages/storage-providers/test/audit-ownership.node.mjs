import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createFileSystemStorageProvider } from "../src/fs-provider.ts";
import { createGitStorageProvider } from "../src/git-storage-provider.ts";
import { createGitManager } from "../src/git-manager.ts";
import { createMongoDBStorageProvider } from "../src/mongodb-storage-provider.ts";
import { revisionOf } from "../src/authority-envelope.ts";

test("F1 three owners: failed post-rmdir sync revokes old handle and cannot delete successor lock", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "weaver-f1-"));
  const options = { id: "fs", layer: "platform", filePath: join(directory, "entries.json"), writable: true, authority: { environment: "default", initialize: true } };
  const one = createFileSystemStorageProvider(options);
  const two = createFileSystemStorageProvider(options);
  let owner2;
  try {
    const owner1 = await one.authority.acquireWriter("one");
    const original = fs.open;
    const fault = mock.method(fs, "open", async (...args) => { if (args[0] === directory) throw new Error("post-rmdir directory sync failure"); return original(...args); });
    syncBuiltinESMExports();
    try { await assert.rejects(one.authority.releaseWriter(owner1), { code: "COMMIT_OUTCOME_UNKNOWN" }); }
    finally { fault.mock.restore(); syncBuiltinESMExports(); }
    owner2 = await two.authority.acquireWriter("two");
    await assert.rejects(one.authority.releaseWriter(owner1), { code: "WRITER_CONFLICT" });
    await assert.rejects(one.authority.releaseQuarantinedWriter(), { code: "UNSUPPORTED_AUTHORITY" });
    const snapshot = await one.authority.readLayer("platform");
    assert.equal((await one.authority.commitLayer({ layer: "platform", operationId: randomUUID(), expectedRevision: revisionOf(snapshot), mutation: { action: "set", key: "illegal", value: 1 } }, owner1)).error.code, "WRITER_CONFLICT");
    const source = `import {createFileSystemStorageProvider} from './src/fs-provider.ts';const p=createFileSystemStorageProvider(${JSON.stringify(options)});try{await p.authority.acquireWriter('third');process.exitCode=9;}catch(e){if(e.code!=='WRITER_CONFLICT')throw e;}`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual((await two.load()).entries, {});
  } finally { if (owner2) await two.authority.releaseWriter(owner2); await fs.rm(directory, { recursive: true, force: true }); }
});

test("F2 actual GitManager integration replicates only and keeps local authority unchanged on divergence", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "weaver-f2-"));
  const calls = [];
  let rejected = true;
  let staged = true;
  const git = {
    async cwd() { calls.push("cwd"); }, async add(file) { calls.push(`add:${file}`); }, async status() { return { staged: staged ? ["entries"] : [] }; },
    async commit() { calls.push("commit"); staged = false; }, async push() { calls.push("push"); if (rejected) throw new Error("non-fast-forward"); },
    async pull() { calls.push("pull"); assert.fail("pull/rebase can replace authority"); }, async raw() { assert.fail("reset/checkout forbidden"); },
  };
  const manager = createGitManager({ repoUrl: "unused", localPath: directory, git });
  const provider = createGitStorageProvider({ id: "git", layer: "platform", filePath: "config/entries.json", gitManager: manager, authority: { environment: "default", initialize: true } });
  try {
    await provider.write("a", 1);
    const before = await fs.readFile(join(directory, "config/entries.json"), "utf8");
    await assert.rejects(provider.flush(), { code: "GIT_ERROR" });
    assert.equal(await fs.readFile(join(directory, "config/entries.json"), "utf8"), before);
    assert.equal(provider.dirty, true);
    rejected = false;
    await provider.flush();
    assert.equal(provider.dirty, false);
    assert.equal(calls.filter((call) => call === "commit").length, 1);
    assert.equal(calls.filter((call) => call === "push").length, 2);
    assert.ok(!calls.includes("pull"));
    const handle = await provider.authority.acquireWriter("service-owner");
    try {
      const blocked = await Promise.all([manager.refresh(), manager.ensureClone(), manager.commitAndPush("blocked", ["config/entries.json"]), manager.revert("old", "actor")]);
      assert.ok(blocked.every((result) => result.success === false));
      assert.ok(!calls.includes("pull"));
    } finally { await provider.authority.releaseWriter(handle); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("F10 obsolete root-document change streams are not installed or opened", () => {
  let watches = 0;
  assert.throws(() => createMongoDBStorageProvider({ id: "old-watch", layer: "platform", environment: "default", collection: { watch() { watches++; return new EventEmitter(); } } }), { code: "UNSUPPORTED_AUTHORITY" });
  assert.equal(watches, 0);
});
