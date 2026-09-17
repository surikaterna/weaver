import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWeaverError } from "@weaver-conf/config-types";
import { createFileSystemStorageProvider, createGitManager, createGitStorageProvider, createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { ConfigAuthority } from "../src/core/config-authority.ts";
import { ConfigServiceController } from "../src/core/config-service-controller.ts";
import { scopeContextId } from "../src/core/scope-inventory.ts";
import { cleanupServer } from "../src/server-cleanup.ts";
import { initializeOwned } from "./owned-fixtures.mjs";
import { createTestService } from "./setup-service.ts";

const inventory = { version: 1, revision: "0", contexts: {} };
const serviceOptions = { environment: "default", requireDurableAuthority: true, scopeInventory: inventory };
function fsProvider(directory, layer = "platform") {
  return createFileSystemStorageProvider({ id: "fs", layer, filePath: join(directory, "entries.json"), writable: true, authority: { environment: "default", initialize: true } });
}

test("F3 offline Git close closes admission, retains replication, releases ownership and never retries cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-f3-"));
  let pushes = 0;
  const manager = createGitManager({ repoUrl: "unused", localPath: directory, git: {
    async cwd() {}, async add() {}, async status() { return { staged: ["entries"] }; }, async commit() {},
    async push() { pushes++; throw new Error("offline"); }, async pull() { assert.fail("not replication-only"); },
  } });
  const provider = createGitStorageProvider({ id: "git", layer: "platform", filePath: "config/entries.json", gitManager: manager, authority: { environment: "default", initialize: true } });
  const service = await initializeOwned({ ...serviceOptions, providers: [provider] }, [{ id: "git", factory: "git", options: { localPath: directory, filePath: "config/entries.json", authority: "local-durable" } }]);
  try {
    assert.equal((await service.set("platform", "svc.a", 1)).success, true);
    const closing = service.close();
    const rejected = assert.rejects(closing, (error) => error.code === "GIT_ERROR" && error.details.cleanup.some((failure) => failure.name === "replication:git"));
    assert.equal((await service.set("platform", "svc.b", 2)).error.code, "SERVER_DEGRADED");
    assert.equal((await service.remove("platform", "svc.a")).error.code, "SERVER_DEGRADED");
    await assert.rejects(service.batch(async () => undefined), {
      code: "SERVER_DEGRADED",
    });
    await rejected;
    await assert.rejects(service.get("svc.a"), { code: "SERVER_DEGRADED" });
    await assert.rejects(service.refreshProviders(), { code: "SERVER_DEGRADED" });
    assert.equal(provider.dirty, true);
    assert.equal(pushes, 1);
    await assert.rejects(service.close(), { code: "GIT_ERROR" });
    assert.equal(pushes, 1);
    const next = await provider.authority.acquireWriter("next");
    assert.deepEqual((await provider.load()).entries.svc, { a: 1 });
    await provider.authority.releaseWriter(next);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("F3 acquisition abort attempts every independent release and preserves original plus cleanup diagnostics", async () => {
  const trace = [];
  function provider(id) {
    const p = createInMemoryStorageProvider({ id, layer: id });
    const acquire = p.authority.acquireWriter.bind(p.authority);
    const release = p.authority.releaseWriter.bind(p.authority);
    p.authority.acquireWriter = async (owner) => { trace.push(`acquire:${id}`); if (id === "c") throw createWeaverError("WRITER_CONFLICT", "original acquire c"); return acquire(owner); };
    p.authority.releaseWriter = async (handle) => { trace.push(`release:${id}`); await release(handle); if (id === "b") throw createWeaverError("COMMIT_OUTCOME_UNKNOWN", "release b"); };
    p.authority.preflight = async () => ({ namespace: id, layers: [id], initialization: "volatile" });
    return p;
  }
  const providers = [provider("a"), provider("b"), provider("c")];
  const authority = new ConfigAuthority("test", "0");
  await assert.rejects(authority.acquire(providers, false), (error) => error.code === "WRITER_CONFLICT" && error.message.includes("original acquire c") && JSON.stringify(error.details).includes("release b"));
  assert.deepEqual(trace, ["acquire:a", "acquire:b", "acquire:c", "release:b", "release:a"]);
  await authority.close();
  assert.equal(trace.length, 5);
});

test("F3 runtime disposal still runs when replication and independent owner cleanup fail", async () => {
  const calls = [];
  const provider = { id: "p", layer: "platform", dirty: true, async flush() { calls.push("flush"); throw createWeaverError("GIT_ERROR", "offline"); } };
  const authority = { async close() { calls.push("owners"); throw createWeaverError("COMMIT_OUTCOME_UNKNOWN", "release failed"); } };
  const host = new ConfigServiceController({ environment: "default", providers: [provider] }, [provider], authority);
  host.runtime.dispose = async () => { calls.push("runtime"); };
  await assert.rejects(host.close(), (error) => error.code === "GIT_ERROR" && error.details.cleanup.length === 2);
  assert.deepEqual(calls, ["flush", "owners", "runtime"]);
  assert.throws(() => host.assertReady(), { code: "SERVER_DEGRADED" });
});

test("F3 HTTP server cleanup reaches all resources even if config close fails", async () => {
  const calls = [];
  const service = { async close() { calls.push("config"); throw createWeaverError("GIT_ERROR", "offline"); }, async flush() { assert.fail("must close admission before flush"); } };
  await assert.rejects(cleanupServer(service, async () => { calls.push("bootstrap"); }, { stopCheckpointTimer() { calls.push("SSE timer"); }, closeAll() { calls.push("SSE clients"); } }, { async stop() { calls.push("HTTP"); } }), { code: "GIT_ERROR" });
  assert.deepEqual(calls, ["config", "SSE timer", "SSE clients", "HTTP", "bootstrap"]);
});

test("F4 read-only facade over mutable durable input holds a real writer capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-f4-"));
  const underlying = fsProvider(directory);
  const facade = { id: underlying.id, layer: underlying.layer, writable: false, authority: underlying.authority, load: () => underlying.load(), write: (...args) => underlying.write(...args), remove: (...args) => underlying.remove(...args) };
  let service;
  try {
    const initialized = await initializeOwned({ ...serviceOptions, providers: [underlying] }, [{ id: "fs", factory: "fs", options: { filePath: join(directory, "entries.json") } }]);
    await initialized.close();
    service = await createWeaverConfigService({ ...serviceOptions, providers: [facade] });
    const revision = service.revision;
    assert.equal((await underlying.write("outside", 1)).error.code, "WRITER_CONFLICT");
    assert.equal((await service.set("platform", "svc.a", 2)).error.code, "READONLY");
    assert.equal((await service.authoritySnapshot()).revision, revision);
    await service.close();
    assert.equal((await underlying.write("outside", 1)).success, true);
  } finally { await service?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("F5/F7 statically scoped orphan rejects before initialization; retired stores deny every mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-f5-"));
  const provider = fsProvider(join(directory, "data"), "tenant:orphan");
  let service;
  try {
    await assert.rejects(createWeaverConfigService({ ...serviceOptions, providers: [provider] }), { code: "UNSUPPORTED_AUTHORITY" });
    assert.deepEqual(await readdir(directory), []);
    const scopePath = [{ scopeId: "tenant", value: "orphan" }];
    const retired = { ...inventory, contexts: { [scopeContextId(scopePath)]: { scopePath, state: "retired" } } };
    const control = createFileSystemStorageProvider({ id: "control", layer: "control", filePath: join(directory, "control", "entries.json"), writable: true, authority: { environment: "default", initialize: true } });
    service = await initializeOwned({ ...serviceOptions, controlLayer: "control", scopeInventory: retired, providers: [control, provider] }, [
      { id: "control", factory: "fs", options: { filePath: join(directory, "control", "entries.json") } },
      { id: "fs", factory: "fs", options: { filePath: join(directory, "data", "entries.json") } },
    ], {}, [{ id: "tenant", label: "Tenant" }]);
    const revision = service.revision;
    for (const result of await Promise.all([service.set(provider.layer, "a", 1), service.remove(provider.layer, "a"), service.setMany(provider.layer, { a: 1 })])) assert.equal(result.error.code, "SCOPE_NOT_FOUND");
    assert.deepEqual((await provider.load()).entries, {});
    assert.deepEqual((await service.resolveAll()).scopes, {});
    assert.equal((await service.authoritySnapshot()).revision, revision);
  } finally { await service?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("F7 all composition and physical preflights precede any durable envelope initialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-f7-"));
  const durable = fsProvider(directory);
  const volatile = createInMemoryStorageProvider({ id: "session", layer: "session" });
  try {
    await assert.rejects(createWeaverConfigService({ ...serviceOptions, providers: [durable, volatile] }), { code: "UNSUPPORTED_AUTHORITY" });
    assert.deepEqual(await readdir(directory), []);
    const unsupported = fsProvider(join(directory, "other"), "region");
    unsupported.id = "other";
    const scopePath = [{ scopeId: "region", value: "missing" }];
    await assert.rejects(createWeaverConfigService({ ...serviceOptions, scopeInventory: { ...inventory, contexts: { [scopeContextId(scopePath)]: { scopePath, state: "active" } } }, providers: [durable, unsupported] }), { code: "UNSUPPORTED_AUTHORITY" });
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const violations = {
  malformed: () => ({ success: true }),
  wrongAck: (result) => ({ ...result, acknowledgement: "durable" }),
  wrongLayer: (result) => ({ ...result, snapshot: { ...result.snapshot, layer: "other" } }),
  wrongEpoch: (result) => ({ ...result, snapshot: { ...result.snapshot, epoch: "00000000-0000-4000-8000-000000000000" } }),
  noReceipt: (result) => ({ ...result, snapshot: { ...result.snapshot, lastCommit: undefined } }),
  wrongOperation: (result) => ({ ...result, snapshot: { ...result.snapshot, lastCommit: { ...result.snapshot.lastCommit, operationId: "00000000-0000-4000-8000-000000000000" } } }),
  wrongDigest: (result) => ({ ...result, snapshot: { ...result.snapshot, lastCommit: { ...result.snapshot.lastCommit, mutationDigest: "0".repeat(64) } } }),
  wrongValue: (result) => ({ ...result, snapshot: { ...result.snapshot, entries: { a: 999 } } }),
};
for (const [name, violate] of Object.entries(violations)) test(`F9 possible-applied provider response ${name} is uncertain and never installed/published`, async () => {
  const provider = createInMemoryStorageProvider({ id: "p", layer: "platform" });
  const service = await createTestService({ environment: "default", providers: [provider] }, { svc: { type: "object", properties: { a: { type: "number" } }, additionalProperties: false } });
  const commit = provider.authority.commitLayer.bind(provider.authority);
  provider.authority.commitLayer = async (...args) => violate(await commit(...args));
  const revision = service.revision;
  const deltas = [];
  service.onDelta((delta) => deltas.push(delta));
  try {
    assert.equal((await service.set("platform", "svc.a", 1)).error.code, "COMMIT_OUTCOME_UNKNOWN");
    assert.deepEqual((await provider.load()).entries, { svc: { a: 1 } });
    assert.equal(service.revision, revision);
    await assert.rejects(service.resolveAll(), { code: "COMMIT_OUTCOME_UNKNOWN" });
    assert.deepEqual(deltas, []);
  } finally { await service.close(); }
});

test("F9 malformed full provider read is rejected before commit", async () => {
  const provider = createInMemoryStorageProvider({ id: "p", layer: "platform" });
  const service = await createTestService({ environment: "default", providers: [provider] }, { svc: { type: "object", properties: { a: { type: "number" } }, additionalProperties: false } });
  const read = provider.authority.readLayer.bind(provider.authority);
  provider.authority.readLayer = async (layer) => ({ ...await read(layer), entries: [] });
  let commits = 0;
  const commit = provider.authority.commitLayer.bind(provider.authority);
  provider.authority.commitLayer = (...args) => { commits++; return commit(...args); };
  try {
    assert.equal((await service.set("platform", "svc.a", 1)).error.code, "COMMIT_OUTCOME_UNKNOWN");
    assert.equal(commits, 0);
    assert.deepEqual((await read("platform")).entries, {});
  } finally { await service.close(); }
});

test("F9 real filesystem durable commit cannot be acknowledged with a volatile receipt mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-f9-durable-"));
  const provider = fsProvider(directory);
  const service = await initializeOwned({ ...serviceOptions, providers: [provider] }, [{ id: "fs", factory: "fs", options: { filePath: join(directory, "entries.json") } }]);
  const commit = provider.authority.commitLayer.bind(provider.authority);
  provider.authority.commitLayer = async (...args) => ({ ...await commit(...args), acknowledgement: "volatile" });
  const revision = service.revision;
  try {
    assert.equal((await service.set("platform", "svc.a", 1)).error.code, "COMMIT_OUTCOME_UNKNOWN");
    assert.deepEqual((await provider.load()).entries.svc, { a: 1 });
    assert.equal(service.revision, revision);
    await assert.rejects(service.get("svc.a"), { code: "COMMIT_OUTCOME_UNKNOWN" });
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
