import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileSystemStorageProvider } from "../src/fs-provider.ts";
import { createInMemoryStorageProvider } from "../src/in-memory-provider.ts";
import { createMongoDBStorageProvider } from "../src/mongodb-storage-provider.ts";
import { revisionOf, freshEnvelope } from "../src/authority-envelope.ts";
import { LayerAuthority } from "../src/layer-authority.ts";
import { createWeaverError } from "@weaver-conf/config-types";
import { createGitStorageProvider } from "../src/git-storage-provider.ts";
import { createGitManager } from "../src/git-manager.ts";

const request = (snapshot, action, key, value) => ({
  layer: snapshot.layer, expectedRevision: revisionOf(snapshot), operationId: randomUUID(),
  mutation: action === "set" ? { action, key, value } : { action, key },
});

async function conformance(provider) {
  const authority = provider.authority;
  assert.ok(authority);
  const owner = await authority.acquireWriter("test-owner");
  try {
    await assert.rejects(authority.acquireWriter("second-owner"), { code: "WRITER_CONFLICT" });
    assert.equal((await provider.write("bypass", 1)).error.code, "WRITER_CONFLICT");
    const initial = await authority.readLayer(provider.layer);
    const operation = request(initial, "set", "app.value", "A");
    const first = await authority.commitLayer(operation, owner);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.snapshot.sequence, "1");
    assert.deepEqual(await authority.commitLayer(operation, owner), first);
    assert.equal((await authority.commitLayer({ ...operation, mutation: { action: "set", key: "app.value", value: "wrong" } }, owner)).error.code, "REVISION_CONFLICT");
    const noop = await authority.commitLayer(request(first.snapshot, "set", "app.value", "A"), owner);
    assert.equal(noop.snapshot.sequence, "1");
    const second = await authority.commitLayer(request(noop.snapshot, "set", "app.value", "B"), owner);
    const third = await authority.commitLayer(request(second.snapshot, "set", "app.value", "A"), owner);
    assert.equal(third.snapshot.sequence, "3");
    assert.equal((await authority.commitLayer(request(first.snapshot, "remove", "app"), owner)).error.code, "REVISION_CONFLICT");
    const loaded = await authority.readLayer(provider.layer);
    loaded.entries.app.value = "external-reference-mutation";
    assert.equal((await authority.readLayer(provider.layer)).entries.app.value, "A");
    const removed = await authority.commitLayer(request(third.snapshot, "remove", "app"), owner);
    assert.deepEqual(removed.snapshot.entries, {});
    assert.equal(removed.snapshot.sequence, "4");
    return removed.snapshot;
  } finally { await authority.releaseWriter(owner); }
}

test("memory authority: CAS, no-op, receipt replay, ABA, tombstone, clone, owner", async () => {
  const provider = createInMemoryStorageProvider({ id: "memory", layer: "platform" });
  const final = await conformance(provider);
  assert.equal(provider.capabilities.kind, "volatile-exclusive");
  const next = createInMemoryStorageProvider({ id: "memory", layer: "platform" });
  assert.notEqual((await next.authority.readLayer("platform")).epoch, final.epoch);
});

test("filesystem real restart and child-process writer exclusion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-core-authority-"));
  const options = { id: "fs", layer: "platform", filePath: join(directory, "entries.json"), writable: true, authority: { environment: "default", initialize: true } };
  try {
    const final = await conformance(createFileSystemStorageProvider(options));
    const restarted = createFileSystemStorageProvider({ ...options, authority: { environment: "default" } });
    assert.deepEqual(await restarted.authority.readLayer("platform"), final);
    const owner = await restarted.authority.acquireWriter("parent");
    const source = `import {createFileSystemStorageProvider} from './src/fs-provider.ts'; const p=createFileSystemStorageProvider(${JSON.stringify(options)}); try { await p.authority.acquireWriter('child'); process.exitCode=9; } catch(e) { if(e.code !== 'WRITER_CONFLICT') throw e; }`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    await restarted.authority.releaseWriter(owner);
    const raw = JSON.parse(await readFile(options.filePath, "utf8"));
    assert.equal(raw.sequence, "4");
    assert.ok(raw.lastCommit);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("filesystem stale lock never auto-steals; malformed envelope and unmanaged files refuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-core-refusal-"));
  const options = { id: "fs", layer: "platform", filePath: join(directory, "entries.json"), writable: true, authority: { environment: "default", initialize: true } };
  try {
    await mkdir(join(directory, ".weaver-writer"));
    await assert.rejects(createFileSystemStorageProvider(options).authority.acquireWriter("new"), { code: "WRITER_CONFLICT" });
    await rm(join(directory, ".weaver-writer"), { recursive: true });
    await writeFile(options.filePath, '{"app":1}');
    const provider = createFileSystemStorageProvider(options);
    await assert.rejects(provider.authority.acquireWriter("test"), { code: "PROVIDER_CORRUPT" });
    await assert.rejects(provider.load(), { code: "PROVIDER_CORRUPT" });
    assert.equal(await readFile(options.filePath, "utf8"), '{"app":1}');
    await writeFile(join(directory, "unmanaged.json"), "{}");
    await assert.rejects(provider.authority.acquireWriter("test"), { code: "UNSUPPORTED_AUTHORITY" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Git local scope IO survives failed replication and retains pending paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-core-git-"));
  const calls = [];
  let fail = true;
  const manager = createGitManager({ localPath: directory, repoUrl: "unused", git: {
    async cwd() {}, async add(path) { calls.push(path); }, async status() { return { staged: ["config"] }; }, async commit() {},
    async push() { if (fail) throw new Error("offline"); }, async pull() { assert.fail("authority replication must not pull"); },
  } });
  const options = { id: "git", layer: "tenant", filePath: "config/entries.json", gitManager: manager, authority: { environment: "default", initialize: true, layers: ["tenant:one"] } };
  try {
    const provider = createGitStorageProvider(options);
    assert.equal((await provider.writeLayer("tenant:one", "app.value", 1)).success, true);
    assert.equal((await provider.loadLayer("tenant:one")).entries.app.value, 1);
    await assert.rejects(provider.flush(), { code: "GIT_ERROR" });
    assert.equal(provider.dirty, true);
    assert.ok(calls.includes("config/entries.json.tenant%3Aone.json"));
    fail = false;
    await provider.flush();
    assert.equal(provider.dirty, false);
    await provider.refresh();
    await assert.rejects(provider.revert("old", "test"), { code: "UNSUPPORTED_AUTHORITY" });
    assert.equal((await createGitStorageProvider(options).loadLayer("tenant:one")).entries.app.value, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real Mongo replica-set authority conformance and restart", { skip: !process.env.WEAVER_TEST_MONGO_URI }, async () => {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(process.env.WEAVER_TEST_MONGO_URI);
  await client.connect();
  const db = client.db(`weaver_core_test_${randomUUID().replaceAll("-", "")}`);
  const collection = db.collection("layers");
  const options = { id: "mongo", layer: "platform", environment: "default", collection, authority: { client, initialize: true } };
  try {
    const final = await conformance(createMongoDBStorageProvider(options));
    const restarted = createMongoDBStorageProvider({ ...options, authority: { client } });
    assert.deepEqual(await restarted.authority.readLayer("platform"), final);
    const owner = await restarted.authority.acquireWriter("parent");
    await assert.rejects(createMongoDBStorageProvider(options).authority.acquireWriter("second"), { code: "WRITER_CONFLICT" });
    await restarted.authority.releaseWriter(owner);
    await collection.updateOne({ layer: "platform" }, { $set: { sequence: "broken" } });
    await assert.rejects(restarted.load(), { code: "PROVIDER_CORRUPT" });
  } finally { await db.dropDatabase(); await client.close(); }
});

test("uncertain commit preserves the receipt and refuses further mutation without claiming rollback", async () => {
  let envelope = freshEnvelope("fault-test", "default", "platform");
  const authority = new LayerAuthority({
    capabilities: { kind: "durable-exclusive", durability: "local-fsync", namespace: "fault-injection", maxEnvelopeBytes: 1_000_000, scopedIO: "complete" },
    async acquire() {}, async release() {}, async layers() { return ["platform"]; }, async read() { return structuredClone(envelope); },
    async persist(next) { envelope = structuredClone(next); throw createWeaverError("COMMIT_OUTCOME_UNKNOWN", "injected post-install acknowledgement loss"); },
  });
  const owner = await authority.acquireWriter("test");
  const operation = request(envelope, "set", "a", 1);
  assert.equal((await authority.commitLayer(operation, owner)).error.code, "COMMIT_OUTCOME_UNKNOWN");
  const observed = await authority.readLayer("platform");
  assert.equal(observed.lastCommit.operationId, operation.operationId);
  assert.equal(observed.entries.a, 1);
  assert.equal((await authority.commitLayer(request(observed, "set", "a", 2), owner)).error.code, "COMMIT_OUTCOME_UNKNOWN");
  await authority.releaseWriter(owner);
});

test("filesystem process termination leaves durable data and a non-stealable ownership lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-core-crash-"));
  const options = { id: "fs", layer: "platform", filePath: join(directory, "entries.json"), writable: true, authority: { environment: "default", initialize: true } };
  try {
    const source = `import {createFileSystemStorageProvider} from './src/fs-provider.ts'; import {revisionOf} from './src/authority-envelope.ts'; import {randomUUID} from 'node:crypto'; const p=createFileSystemStorageProvider(${JSON.stringify(options)}); const owner=await p.authority.acquireWriter('child'); const current=await p.authority.readLayer('platform'); const result=await p.authority.commitLayer({layer:'platform',expectedRevision:revisionOf(current),operationId:randomUUID(),mutation:{action:'set',key:'saved',value:1}},owner); process.exit(result.success?0:9);`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const restarted = createFileSystemStorageProvider(options);
    assert.equal((await restarted.load()).entries.saved, 1);
    await assert.rejects(restarted.authority.acquireWriter("restart"), { code: "WRITER_CONFLICT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real Mongo lost fence prevents old writer commit; legacy records refuse without deletion", { skip: !process.env.WEAVER_TEST_MONGO_URI }, async () => {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(process.env.WEAVER_TEST_MONGO_URI);
  await client.connect();
  const db = client.db(`weaver_core_test_${randomUUID().replaceAll("-", "")}`);
  const collection = db.collection("layers");
  const options = { id: "mongo", layer: "platform", environment: "default", collection, authority: { client, initialize: true } };
  try {
    const provider = createMongoDBStorageProvider(options);
    const owner = await provider.authority.acquireWriter("old");
    const initial = await provider.authority.readLayer("platform");
    await collection.updateOne({ layer: "platform" }, { $set: { owner: randomUUID(), fence: "9" } }, { writeConcern: { w: "majority", j: true } });
    assert.equal((await provider.authority.commitLayer(request(initial, "set", "illegal", 1), owner)).error.code, "REVISION_CONFLICT");
    assert.deepEqual((await provider.load()).entries, {});
    const old = db.collection("legacy");
    await old.insertOne({ layer: "platform", environment: "default", key: "billing.__proto__", value: "bad", updatedAt: "2026" });
    const legacy = createMongoDBStorageProvider({ ...options, collection: old });
    await assert.rejects(legacy.authority.acquireWriter("new"), { code: "PROVIDER_CORRUPT" });
    assert.equal(await old.countDocuments({}), 1);
  } finally { await db.dropDatabase(); await client.close(); }
});

test("real standalone Mongo refuses durable authority before creating config", { skip: !process.env.WEAVER_TEST_MONGO_STANDALONE_URI }, async () => {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(process.env.WEAVER_TEST_MONGO_STANDALONE_URI);
  await client.connect();
  const db = client.db(`weaver_core_test_${randomUUID().replaceAll("-", "")}`);
  const collection = db.collection("layers");
  try {
    const provider = createMongoDBStorageProvider({ id: "standalone", layer: "platform", environment: "default", collection, authority: { client, initialize: true } });
    await assert.rejects(provider.authority.acquireWriter("test"), { code: "UNSUPPORTED_AUTHORITY" });
    assert.equal(await collection.countDocuments({}), 0);
  } finally { await db.dropDatabase(); await client.close(); }
});
