import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createStandaloneFixture, testAdmin, testJwt } from "./standalone-fixture.ts";
import { initializeWeaver } from "../src/bootstrap/initialize.ts";
import { authenticateBootstrapAdministrator } from "../src/bootstrap/seed-trust.ts";
import { seedProviderDefinition } from "../src/bootstrap/compile-layout.ts";
import { startWeaverServer } from "../src/server.ts";

const schema = { type: "object", default: {}, additionalProperties: false, properties: { value: { type: "integer", default: 1 } } };

test("qkmd real local Git checkout seed uses local durable authority without remote mutation", { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: schema } });
  let server;
  try {
    const repo = join(fixture.directory, "checkout");
    await promisify(execFile)("git", ["init", "--initial-branch=main", repo], { timeout: 10_000 });
    const seed = { ...fixture.seed, store: { factory: "git", locator: { localPath: repo, filePath: "control/entries.json" } } };
    const input = structuredClone(fixture.request);
    input.generation.providers[0] = seedProviderDefinition(seed);
    const administrator = await authenticateBootstrapAdministrator(seed, testAdmin, fixture.credentials);
    await initializeWeaver(seed, input, administrator, { credentials: fixture.credentials });
    server = await startWeaverServer({ seed, credentials: fixture.credentials });
    assert.equal((await server.runtime.configService.set("platform", "svc.value", 7)).success, true);
    const revision = server.runtime.configService.revision;
    await server.close();
    server = await startWeaverServer({ seed, credentials: fixture.credentials });
    assert.equal(server.runtime.configService.revision, revision);
    assert.equal(await server.runtime.configService.get("svc.value"), 7);
    assert.equal(server.runtime.configService.providers.find((provider) => provider.id === "control").dirty, false);
  } finally { await server?.close(); await fixture.dispose(); }
});

test("qkmd real Mongo seed initialize/start/read/close/restart and failed reload is nonready", { timeout: 60_000, skip: !process.env.WEAVER_TEST_MONGO_URI }, async () => {
  const { MongoClient } = await import("mongodb");
  const uri = process.env.WEAVER_TEST_MONGO_URI;
  const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 }).connect();
  const database = `weaver_bootstrap_test_${randomUUID().replaceAll("-", "")}`;
  const fixture = await createStandaloneFixture({ schemas: { svc: schema } });
  let server;
  try {
    const storeId = `mongo:${client.options.hosts.map((host) => host.toString()).sort().join(",")}/${database}.control`;
    const seed = { ...fixture.seed, store: { factory: "mongodb", locator: { connectionRef: "database", database, collection: "control", storeId } } };
    const credentials = { resolveCredential: (ref) => ref === "database" ? uri : ref === "administrator" ? testAdmin : ref === "jwt" ? testJwt : undefined };
    const input = structuredClone(fixture.request);
    input.generation.providers = [seedProviderDefinition(seed), { id: "platform", factory: "mongodb", options: { database, collection: "platform" }, credentials: { connection: "database" } }];
    const administrator = await authenticateBootstrapAdministrator(seed, testAdmin, credentials);
    await initializeWeaver(seed, input, administrator, { credentials });
    server = await startWeaverServer({ seed, credentials });
    assert.equal((await server.runtime.configService.set("platform", "svc.value", 9)).success, true);
    const revision = server.runtime.configService.revision;
    await server.close();
    server = await startWeaverServer({ seed, credentials });
    assert.equal(server.runtime.configService.revision, revision);
    assert.equal(await server.runtime.configService.get("svc.value"), 9);
    const collection = client.db(database).collection("platform");
    const original = await collection.findOne({ layer: "platform" });
    await collection.updateOne({ layer: "platform" }, { $set: { sequence: "corrupt" } });
    await assert.rejects(server.runtime.configService.reloadProvider("platform"));
    assert.equal(server.isReady, false);
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/readyz`, { signal: AbortSignal.timeout(30_000) })).status, 503);
    await collection.updateOne({ layer: "platform" }, { $set: { sequence: original.sequence } });
    await server.runtime.configService.reloadProvider("platform");
    assert.equal(await server.runtime.configService.get("svc.value"), 9);
  } finally { await server?.close(); await client.db(database).dropDatabase(); await client.close(); await fixture.dispose(); }
});

test("qkmd control relocation requires a new explicit seed and leaves the old target untouched", { timeout: 30_000 }, async () => {
  const first = await createStandaloneFixture();
  const second = await createStandaloneFixture();
  try {
    await initializeWeaver(first.seed, first.request, first.administrator, { credentials: first.credentials });
    const before = await readFile(first.seed.store.locator.filePath, "utf8");
    await assert.rejects(initializeWeaver(second.seed, second.request, first.administrator, { credentials: second.credentials }), { code: "FORBIDDEN" });
    await initializeWeaver(second.seed, second.request, second.administrator, { credentials: second.credentials });
    const server = await startWeaverServer({ seed: second.seed, credentials: second.credentials });
    await server.close();
    assert.equal(await readFile(first.seed.store.locator.filePath, "utf8"), before);
  } finally { await first.dispose(); await second.dispose(); }
});

test("qkmd required stored secrets resolve through injected code before port binding and failed startup releases owners", { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture({ schemas: { svc: { type: "object", default: {}, properties: { password: { type: "string" } } } } });
  let available = true;
  const secretBackend = { async resolve(reference) { return reference.provider === "injected" && reference.uri === "password" && available ? "resolved-secret" : undefined; } };
  let server;
  try {
    await initializeWeaver(fixture.seed, fixture.request, fixture.administrator, { credentials: fixture.credentials });
    server = await startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials, secretBackend });
    assert.equal((await server.runtime.configService.set("platform", "svc.password", { _weaver: "secret-ref", provider: "injected", uri: "password" })).success, true);
    assert.equal(await server.runtime.configService.get("svc.password"), "resolved-secret");
    await server.close(); server = undefined;
    available = false;
    await assert.rejects(startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials, secretBackend }), { code: "CONFIG_NOT_READY" });
    available = true;
    server = await startWeaverServer({ seed: fixture.seed, credentials: fixture.credentials, secretBackend });
    assert.equal(await server.runtime.configService.get("svc.password"), "resolved-secret");
  } finally { await server?.close(); await fixture.dispose(); }
});
