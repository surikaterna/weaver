import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { MongoClient, Collection } from "mongodb";
import { createMongoDBStorageProvider } from "../src/mongodb-storage-provider.ts";
import { revisionOf } from "../src/authority-envelope.ts";

async function fixture(run) {
  const client = await new MongoClient(process.env.WEAVER_TEST_MONGO_URI).connect();
  const db = client.db(`weaver_core_test_${randomUUID().replaceAll("-", "")}`);
  const collection = db.collection("layers");
  const options = { id: "mongo", layer: "platform", environment: "default", collection, authority: { client, initialize: true, layers: ["tenant:one"] } };
  try { await run({ client, db, collection, options }); }
  finally { await db.dropDatabase(); await client.close(); }
}
const live = { skip: !process.env.WEAVER_TEST_MONGO_URI };

for (const applied of [false, true]) test(`F6 real Mongo uncertain acquire retains two-layer evidence; applied=${applied}`, live, async () => fixture(async ({ db, collection, options }) => {
  const initial = createMongoDBStorageProvider(options);
  const handle = await initial.authority.acquireWriter("initialize");
  await initial.authority.releaseWriter(handle);
  const provider = createMongoDBStorageProvider(options);
  const original = Collection.prototype.updateOne;
  let injected = false;
  const fault = mock.method(Collection.prototype, "updateOne", async function (...args) {
    const [filter, update] = args;
    if (this.dbName === db.databaseName && filter.layer === "tenant:one" && filter.owner === null && update.$set.owner && !injected) {
      injected = true;
      if (applied) await original.apply(this, args);
      throw new Error("ownership response lost");
    }
    return original.apply(this, args);
  });
  try { await assert.rejects(provider.authority.acquireWriter("owner"), (error) => error.code === "COMMIT_OUTCOME_UNKNOWN" && error.details.ownership.layers.length === 2); }
  finally { fault.mock.restore(); }
  const evidence = await provider.authority.inspectOwnership();
  assert.equal(evidence.layers.find((layer) => layer.layer === "platform").observed, "owned");
  assert.equal(evidence.layers.find((layer) => layer.layer === "tenant:one").observed, applied ? "owned" : "not-applied");
  await assert.rejects(provider.authority.acquireWriter("retry"), { code: "COMMIT_OUTCOME_UNKNOWN" });
  await provider.authority.releaseQuarantinedWriter();
  assert.equal(await collection.countDocuments({ owner: { $ne: null } }), 0);
  const next = createMongoDBStorageProvider(options);
  const owner = await next.authority.acquireWriter("next");
  await next.authority.releaseWriter(owner);
}));

test("F6 real Mongo lost release acknowledgement revokes handle, releases other layers, cannot release successor", live, async () => fixture(async ({ db, collection, options }) => {
  const provider = createMongoDBStorageProvider(options);
  const handle = await provider.authority.acquireWriter("one");
  const original = Collection.prototype.updateOne;
  let injected = false;
  const fault = mock.method(Collection.prototype, "updateOne", async function (...args) {
    const result = await original.apply(this, args);
    if (this.dbName === db.databaseName && args[0].layer === "platform" && args[1].$set.owner === null && !injected) { injected = true; throw new Error("release response lost"); }
    return result;
  });
  try { await assert.rejects(provider.authority.releaseWriter(handle), { code: "COMMIT_OUTCOME_UNKNOWN" }); }
  finally { fault.mock.restore(); }
  assert.equal(await collection.countDocuments({ owner: { $ne: null } }), 0);
  assert.ok((await provider.authority.inspectOwnership()).layers.every((layer) => layer.observed === "released"));
  const next = createMongoDBStorageProvider(options);
  const owner2 = await next.authority.acquireWriter("two");
  const before = await collection.find({}).toArray();
  await assert.rejects(provider.authority.releaseWriter(handle), { code: "WRITER_CONFLICT" });
  await assert.rejects(provider.authority.releaseQuarantinedWriter(), { code: "COMMIT_OUTCOME_UNKNOWN" });
  assert.deepEqual(await collection.find({}).toArray(), before);
  await next.authority.releaseWriter(owner2);
}));

test("F8 real Mongo adoption requires a complete compatible unique index before ownership changes", live, async () => fixture(async ({ collection, options }) => {
  const provider = createMongoDBStorageProvider(options);
  const handle = await provider.authority.acquireWriter("initial");
  await provider.authority.releaseWriter(handle);
  const before = await collection.find({}).toArray();
  await collection.dropIndex("environment_1_layer_1");
  await assert.rejects(createMongoDBStorageProvider(options).authority.acquireWriter("missing"), { code: "UNSUPPORTED_AUTHORITY" });
  await collection.createIndex({ environment: 1, layer: 1 }, { unique: true, sparse: true });
  await assert.rejects(createMongoDBStorageProvider(options).authority.acquireWriter("sparse"), { code: "UNSUPPORTED_AUTHORITY" });
  assert.deepEqual(await collection.find({}).toArray(), before);
  await collection.dropIndex("environment_1_layer_1");
  await collection.createIndex({ layer: -1, environment: 1 }, { unique: true });
  const valid = createMongoDBStorageProvider(options);
  const adopted = await valid.authority.acquireWriter("compatible");
  await valid.authority.releaseWriter(adopted);
}));

test("F6 real Mongo pre-effect release failure keeps its token while independent layers release", live, async () => fixture(async ({ db, collection, options }) => {
  const provider = createMongoDBStorageProvider(options);
  const handle = await provider.authority.acquireWriter("owner");
  const original = Collection.prototype.updateOne;
  const fault = mock.method(Collection.prototype, "updateOne", async function (...args) {
    if (this.dbName === db.databaseName && args[0].layer === "platform" && args[1].$set.owner === null) throw new Error("pre-effect release failure");
    return original.apply(this, args);
  });
  try { await assert.rejects(provider.authority.releaseWriter(handle), { code: "COMMIT_OUTCOME_UNKNOWN" }); }
  finally { fault.mock.restore(); }
  const evidence = await provider.authority.inspectOwnership();
  assert.equal(evidence.layers.find((layer) => layer.layer === "platform").observed, "owned");
  assert.equal(evidence.layers.find((layer) => layer.layer === "tenant:one").observed, "released");
  await provider.authority.releaseQuarantinedWriter();
  assert.equal(await collection.countDocuments({ owner: { $ne: null } }), 0);
  const next = createMongoDBStorageProvider(options);
  const successor = await next.authority.acquireWriter("successor");
  await assert.rejects(provider.authority.releaseWriter(handle), { code: "WRITER_CONFLICT" });
  await next.authority.releaseWriter(successor);
}));

test("F6-A real Mongo recovery fences a held acquisition before declaring settlement", live, async () => fixture(async ({ db, collection, options }) => {
  const initial = createMongoDBStorageProvider(options);
  const initialHandle = await initial.authority.acquireWriter("initialize");
  await initial.authority.releaseWriter(initialHandle);
  const provider = createMongoDBStorageProvider(options);
  const before = await provider.authority.readLayer("tenant:one");
  const original = Collection.prototype.updateOne;
  let delayed;
  const fault = mock.method(Collection.prototype, "updateOne", async function (...args) {
    if (this.dbName === db.databaseName && args[0].layer === "tenant:one" && args[0].owner === null && args[1].$set.owner) {
      delayed = () => original.apply(this, args);
      throw new Error("response lost while acquisition remains in flight");
    }
    return original.apply(this, args);
  });
  try { await assert.rejects(provider.authority.acquireWriter("pending"), { code: "COMMIT_OUTCOME_UNKNOWN" }); }
  finally { fault.mock.restore(); }
  assert.equal(typeof delayed, "function");
  assert.equal((await provider.authority.inspectOwnership()).layers.find((layer) => layer.layer === "tenant:one").observed, "not-applied");
  await provider.authority.releaseQuarantinedWriter();
  assert.equal(await collection.countDocuments({ owner: { $ne: null } }), 0);
  assert.ok((await provider.authority.inspectOwnership()).layers.every((layer) => layer.observed === "released"));
  // Execute the actual original Mongo update before any successor can hide an unfenced tuple.
  assert.equal((await delayed()).matchedCount, 0);
  assert.equal(await collection.countDocuments({ owner: { $ne: null } }), 0);
  assert.deepEqual(await provider.authority.readLayer("tenant:one"), before);
  const recovered = await provider.authority.acquireWriter("recovered");
  const result = await provider.authority.commitLayer({ layer: "tenant:one", expectedRevision: revisionOf(before), operationId: randomUUID(), mutation: { action: "set", key: "recovered", value: true } }, recovered);
  assert.equal(result.success, true);
  await provider.authority.releaseWriter(recovered);
  const successor = createMongoDBStorageProvider(options);
  const handle = await successor.authority.acquireWriter("successor");
  assert.equal((await successor.loadLayer("tenant:one")).entries.recovered, true);
  await successor.authority.releaseWriter(handle);
}));

test("F6-B real Mongo abort preserves conflict diagnostics while uncertain cleanup remains recoverable", live, async () => fixture(async ({ db, collection, options }) => {
  const provider = createMongoDBStorageProvider(options);
  const original = Collection.prototype.updateOne;
  const otherOwner = randomUUID();
  const fault = mock.method(Collection.prototype, "updateOne", async function (...args) {
    const [filter, update] = args;
    if (this.dbName === db.databaseName && filter.layer === "tenant:one" && filter.owner === null && update.$set.owner) {
      // A real competing conditional write wins the later document after platform is acquired.
      await original.call(this, filter, { $set: { owner: otherOwner, fence: update.$set.fence } }, args[2]);
    }
    if (this.dbName === db.databaseName && filter.layer === "platform" && update.$set.owner === null) throw new Error("abort cleanup failed before effect");
    return original.apply(this, args);
  });
  try {
    await assert.rejects(provider.authority.acquireWriter("partial"), (error) => {
      assert.equal(error.code, "WRITER_CONFLICT");
      assert.equal(error.details.primary.code, "WRITER_CONFLICT");
      assert.ok(JSON.stringify(error.details.cleanup).includes("requires reconciliation"));
      return true;
    });
  } finally { fault.mock.restore(); }
  const evidence = await provider.authority.inspectOwnership();
  assert.equal(evidence.layers.find((layer) => layer.layer === "platform").observed, "owned");
  assert.equal(evidence.layers.find((layer) => layer.layer === "tenant:one").observed, "lost");
  const competitor = await collection.findOne({ layer: "tenant:one" });
  await assert.rejects(provider.authority.acquireWriter("unsafe retry"), { code: "COMMIT_OUTCOME_UNKNOWN" });
  await provider.authority.releaseQuarantinedWriter();
  assert.equal((await collection.findOne({ layer: "platform" })).owner, null);
  assert.deepEqual(await collection.findOne({ layer: "tenant:one" }), competitor);
  // The simulated competitor releases only its own test tuple; recovery must not do that for it.
  assert.equal((await collection.updateOne({ layer: "tenant:one", owner: otherOwner, fence: competitor.fence }, { $set: { owner: null } }, { writeConcern: { w: "majority", j: true } })).matchedCount, 1);
  const recovered = await provider.authority.acquireWriter("recovered");
  const current = await provider.authority.readLayer("platform");
  assert.equal((await provider.authority.commitLayer({ layer: "platform", expectedRevision: revisionOf(current), operationId: randomUUID(), mutation: { action: "set", key: "afterAbort", value: true } }, recovered)).success, true);
  await provider.authority.releaseWriter(recovered);
  const successor = createMongoDBStorageProvider(options);
  const handle = await successor.authority.acquireWriter("successor");
  assert.equal((await successor.load()).entries.afterAbort, true);
  await successor.authority.releaseWriter(handle);
}));
