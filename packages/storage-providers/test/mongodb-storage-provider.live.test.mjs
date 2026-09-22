import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { createMongoDBStorageProvider } from "../src/mongodb-storage-provider.ts";

const topologies = [
  ["replica set", process.env.WEAVER_TEST_MONGO_URI],
  ["standalone", process.env.WEAVER_TEST_MONGO_STANDALONE_URI],
];

for (const [topology, uri] of topologies) {
  registerTopologySuite(topology, uri);
}

function registerTopologySuite(topology, uri) {
  const state = { client: undefined, collection: undefined, database: "" };
  const commands = [];
  describe.skipIf(uri === undefined)(
    `MongoDB provider real-driver integrity (${topology})`,
    () => {
      beforeAll(() => openMongoFixture(state, uri, commands));
      beforeEach(() => resetMongoFixture(state, commands));
      afterAll(() => closeMongoFixture(state));
      test("persists nested writes as one authoritative root", () =>
        assertAuthoritativeRoot(state.collection));
      test("preserves concurrent mutations from distinct providers", () =>
        assertConcurrentMutations(state.collection));
      test("preserves literal dotted root identity during concurrent writes", () =>
        assertConcurrentLiteralRoot(state.collection));
      test("removes only exact path aliases and descendants", () =>
        assertExactRemoval(state.collection));
      test("sends bounded key-only alias discovery queries", () =>
        assertBoundedDiscovery(state.collection, commands));
    },
  );
}

async function openMongoFixture(state, uri, commands) {
  state.client = await new MongoClient(uri, {
    monitorCommands: true,
    serverSelectionTimeoutMS: 10_000,
  }).connect();
  state.client.on("commandStarted", (event) => commands.push(event));
  state.database = `weaver_provider_${randomUUID().replaceAll("-", "")}`;
  state.collection = state.client.db(state.database).collection("configuration");
}

async function resetMongoFixture(state, commands) {
  commands.length = 0;
  await state.collection.deleteMany({});
}

async function closeMongoFixture(state) {
  await state.client.db(state.database).dropDatabase();
  await state.client.close();
}

async function assertAuthoritativeRoot(collection) {
  const provider = createProvider(collection);
  expect((await provider.write("billing.plan", "pro")).success).toBe(true);
  expect((await provider.write("billing.limits.seats", 10)).success).toBe(true);
  const docs = await collection
    .find({ layer: "platform", environment: "test" })
    .toArray();
  expect(docs).toHaveLength(1);
  expect(docs[0].key).toBe("billing");
  expect(docs[0].value).toEqual({ plan: "pro", limits: { seats: 10 } });
  expect((await provider.load()).entries.billing).toEqual(docs[0].value);
}

async function assertConcurrentMutations(collection) {
  const first = createProvider(collection, "mongo-platform-first");
  const second = createProvider(collection, "mongo-platform-second");
  const writes = await Promise.all([
    first.write("billing.plan", "pro"),
    second.write("billing.limits.seats", 10),
  ]);
  expect(writes.every((result) => result.success)).toBe(true);
  const mixed = await Promise.all([
    first.write("billing.limits.requests", 1_000),
    second.remove("billing.plan"),
  ]);
  expect(mixed.every((result) => result.success)).toBe(true);
  expect((await createProvider(collection).load()).entries.billing).toEqual({
    limits: { seats: 10, requests: 1_000 },
  });
}

async function assertConcurrentLiteralRoot(collection) {
  const first = createProvider(collection, "mongo-literal-first");
  const second = createProvider(collection, "mongo-literal-second");
  const results = await Promise.all([
    first.write("[billing.plan].tier", "pro"),
    second.write("[billing.plan].seats", 10),
  ]);
  expect(results.every((result) => result.success)).toBe(true);
  const entries = (await createProvider(collection).load()).entries;
  expect(entries["billing.plan"]).toEqual({ tier: "pro", seats: 10 });
  expect(entries.billing).toBe(undefined);
}

async function assertExactRemoval(collection) {
  await collection.insertMany([
    stored("[billing]", { plan: "new" }),
    stored("billing.plan", "stale"),
    stored("billing[limits]", { seats: 10 }),
    stored("billings", "keep"),
    stored("[billing.plan]", "keep dotted root"),
    stored("[billing2]", "keep alias"),
  ]);
  expect((await createProvider(collection).remove("billing")).success).toBe(true);
  const remaining = await collection
    .find({ layer: "platform", environment: "test" })
    .sort({ key: 1 })
    .toArray();
  expect(remaining.map((doc) => doc.key)).toEqual([
    "[billing.plan]",
    "[billing2]",
    "billings",
  ]);
}

async function assertBoundedDiscovery(collection, commands) {
  await collection.insertOne(stored("billing.plan", "legacy"));
  commands.length = 0;
  const result = await createProvider(collection).write("billing", {
    plan: "current",
  });
  expect(result.success).toBe(true);
  const find = commands.find((event) => event.commandName === "find");
  expect(find.command.filter).toMatchObject({
    layer: "platform",
    environment: "test",
    key: { $regex: expect.stringMatching(/^\^.*billing/) },
  });
  expect(find.command.projection).toEqual({ _id: 0, key: 1 });
}

function createProvider(collection, id = "mongo-platform") {
  return createMongoDBStorageProvider({
    id,
    layer: "platform",
    collection,
    environment: "test",
  });
}

function stored(key, value) {
  return {
    layer: "platform",
    environment: "test",
    key,
    value,
    updatedAt: new Date().toISOString(),
  };
}
