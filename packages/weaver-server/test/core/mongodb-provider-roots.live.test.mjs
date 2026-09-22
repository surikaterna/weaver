import { randomUUID } from "node:crypto";
import { createMongoDBStorageProvider } from "@weaver-conf/storage-providers";
import { MongoClient } from "mongodb";
import { createWeaverConfigService } from "../../src/core/config-service.ts";

const uri = process.env.WEAVER_TEST_MONGO_URI;

describe.skipIf(uri === undefined)("Weaver server MongoDB root persistence", () => {
  let client;
  let collection;
  let database;

  beforeAll(async () => {
    client = await new MongoClient(uri, {
      serverSelectionTimeoutMS: 10_000,
    }).connect();
    database = `weaver_server_${randomUUID().replaceAll("-", "")}`;
    collection = client.db(database).collection("configuration");
  });

  beforeEach(async () => {
    await collection.deleteMany({});
  });

  afterAll(async () => {
    await client.db(database).dropDatabase();
    await client.close();
  });

  test("nested writes survive service reconstruction as one root", async () => {
    const service = await createService(collection);

    expect((await service.set("platform", "billing.plan", "pro")).success).toBe(
      true,
    );
    expect(
      (await service.set("platform", "billing.limits.seats", 10)).success,
    ).toBe(true);

    const stored = await collection
      .find({ layer: "platform", environment: "test" })
      .toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      key: "billing",
      value: { plan: "pro", limits: { seats: 10 } },
    });

    const restarted = await createService(collection);
    expect(await restarted.getNamespace("billing")).toEqual({
      plan: "pro",
      limits: { seats: 10 },
    });
  });
});

function createService(collection) {
  const provider = createMongoDBStorageProvider({
    id: "mongo-platform",
    layer: "platform",
    collection,
    environment: "test",
  });
  return createWeaverConfigService({ providers: [provider], environment: "test" });
}
