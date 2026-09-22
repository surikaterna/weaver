import { randomUUID } from "node:crypto";
import { createMongoDBStorageProvider } from "@weaver-conf/storage-providers";
import { MongoClient } from "mongodb";
import { createWeaverConfigService } from "../../src/core/config-service.ts";

const topologies = [
  ["replica set", process.env.WEAVER_TEST_MONGO_URI],
  ["standalone", process.env.WEAVER_TEST_MONGO_STANDALONE_URI],
];

for (const [topology, uri] of topologies) {
  registerTopologySuite(topology, uri);
}

function registerTopologySuite(topology, uri) {
  const state = { client: undefined, collection: undefined, database: "" };
  describe.skipIf(uri === undefined)(
    `Weaver server MongoDB root persistence (${topology})`,
    () => {
      beforeAll(() => openMongoFixture(state, uri));
      beforeEach(() => state.collection.deleteMany({}));
      afterAll(() => closeMongoFixture(state));
      test("concurrent writes survive service reconstruction as one root", () =>
        assertConcurrentReconstruction(state.collection));
    },
  );
}

async function openMongoFixture(state, uri) {
  state.client = await new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
  }).connect();
  state.database = `weaver_server_${randomUUID().replaceAll("-", "")}`;
  state.collection = state.client.db(state.database).collection("configuration");
}

async function closeMongoFixture(state) {
  await state.client.db(state.database).dropDatabase();
  await state.client.close();
}

async function assertConcurrentReconstruction(collection) {
  const first = await createService(collection, "mongo-platform-first");
  const second = await createService(collection, "mongo-platform-second");
  const results = await Promise.all([
    first.set("platform", "billing.plan", "pro"),
    second.set("platform", "billing.limits.seats", 10),
  ]);
  expect(results.every((result) => result.success)).toBe(true);
  const stored = await collection
    .find({ layer: "platform", environment: "test" })
    .toArray();
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    key: "billing",
    value: { plan: "pro", limits: { seats: 10 } },
  });
  const restarted = await createService(collection, "mongo-platform-restarted");
  expect(await restarted.getNamespace("billing")).toEqual(stored[0].value);
}

function createService(collection, id) {
  const provider = createMongoDBStorageProvider({
    id,
    layer: "platform",
    collection,
    environment: "test",
  });
  return createWeaverConfigService({ providers: [provider], environment: "test" });
}
