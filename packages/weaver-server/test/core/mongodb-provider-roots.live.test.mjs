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
      test("delete/recreate survives a stale service writer and reconstruction", () =>
        assertDeleteRecreateReconstruction(state.collection));
      test("removed duplicate roots do not reappear after reconstruction", () =>
        assertDuplicateRemovalReconstruction(state.collection));
      test("concurrent fresh roots survive duplicate cleanup and reconstruction", () =>
        assertDuplicateRecreationReconstruction(state.collection));
      test("value-only cleanup races survive service reconstruction", () =>
        assertValueRaceReconstruction(state.collection));
      test("overflow and strict cleanup retry reconstruct safely", () =>
        assertOverflowAndRetryReconstruction(state.collection));
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

async function assertDeleteRecreateReconstruction(collection) {
  const setup = await createService(collection, "mongo-aba-setup");
  expect((await setup.set("platform", "billing", { base: true })).success)
    .toBe(true);
  const gate = delayedFirstUpdate(collection);
  const stale = await createService(gate.collection, "mongo-aba-stale");
  const recreator = await createService(collection, "mongo-aba-recreator");

  const staleWrite = stale.set("platform", "billing.a", 1);
  await gate.reached;
  expect((await recreator.remove("platform", "billing")).success).toBe(true);
  expect((await recreator.set("platform", "billing.c", 3)).success).toBe(true);
  gate.release();
  expect((await staleWrite).success).toBe(true);

  const restarted = await createService(collection, "mongo-aba-restarted");
  expect(await restarted.getNamespace("billing")).toEqual({ c: 3, a: 1 });
}

async function assertDuplicateRemovalReconstruction(collection) {
  await seedDuplicateRoots(collection);
  const remover = await createService(collection, "mongo-duplicate-remover");

  expect((await remover.remove("platform", "billing")).success).toBe(true);

  const restarted = await createService(collection, "mongo-duplicate-restarted");
  expect(await restarted.getNamespace("billing")).toEqual({});
  expect(await collection.countDocuments({ key: "billing" })).toBe(0);
}

async function assertDuplicateRecreationReconstruction(collection) {
  await seedDuplicateRoots(collection);
  const gate = delayedFirstOperation(collection, "deleteOne");
  const remover = await createService(gate.collection, "mongo-duplicate-remover");
  const recreator = await createService(collection, "mongo-duplicate-recreator");

  const removal = remover.remove("platform", "billing");
  await gate.reached;
  expect((await recreator.remove("platform", "billing")).success).toBe(true);
  expect((await recreator.set("platform", "billing", { fresh: true })).success)
    .toBe(true);
  gate.release();
  expect((await removal).success).toBe(true);

  const restarted = await createService(collection, "mongo-fresh-restarted");
  expect(await restarted.getNamespace("billing")).toEqual({ fresh: true });
  expect(await collection.countDocuments({ key: "billing" })).toBe(1);
}

async function assertValueRaceReconstruction(collection) {
  await collection.insertOne({
    layer: "platform",
    environment: "test",
    key: "billing.plan",
    value: "old",
    updatedAt: "2024-01-01T00:00:00.000Z",
  });
  const gate = delayedFirstOperation(collection, "deleteOne");
  const remover = await createService(gate.collection, "mongo-value-remover");
  const removal = remover.remove("platform", "billing");
  await gate.reached;
  await collection.updateOne(
    { key: "billing.plan" },
    { $set: { value: "fresh" } },
  );
  gate.release();
  expect((await removal).success).toBe(true);

  const restarted = await createService(collection, "mongo-value-restarted");
  expect(await restarted.getNamespace("billing")).toEqual({ plan: "fresh" });
}

async function assertOverflowAndRetryReconstruction(collection) {
  await collection.insertMany(
    Array.from({ length: 257 }, (_, index) => ({
      layer: "platform",
      environment: "test",
      key: `billing.child${index}`,
      value: index,
      updatedAt: "2024-01-01T00:00:00.000Z",
    })),
  );
  const service = await createService(collection, "mongo-overflow");
  const overflow = await service.set("platform", "billing.current", true);
  expect(overflow).toMatchObject({ success: false, error: { code: "WRITE_ERROR" } });
  expect(await collection.countDocuments({})).toBe(257);

  await collection.deleteMany({});
  await collection.insertOne({
    layer: "platform",
    environment: "test",
    key: "billing.plan",
    value: "pro",
    updatedAt: "2024-01-01T00:00:00.000Z",
  });
  const failing = failDeletes(collection);
  const first = await createService(failing, "mongo-strict-first");
  expect((await first.remove("platform", "billing")).success).toBe(false);
  const retry = await createService(collection, "mongo-strict-retry");
  expect(await retry.getNamespace("billing")).toEqual({ plan: "pro" });
  expect((await retry.remove("platform", "billing")).success).toBe(true);
  const restarted = await createService(collection, "mongo-strict-restarted");
  expect(await restarted.getNamespace("billing")).toEqual({});
}

function failDeletes(collection) {
  return new Proxy(collection, {
    get(target, property) {
      if (property === "deleteOne") {
        return async () => { throw new Error("strict cleanup failure"); };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

async function seedDuplicateRoots(collection) {
  const setup = await createService(collection, "mongo-duplicate-setup");
  expect((await setup.set("platform", "billing", { current: true })).success)
    .toBe(true);
  await collection.insertOne({
    layer: "platform",
    environment: "test",
    key: "billing",
    value: { old: true },
    updatedAt: "2024-01-01T00:00:00.000Z",
  });
}

function delayedFirstUpdate(collection) {
  let signalReached;
  let releaseUpdate;
  let delayed = false;
  const reached = new Promise((resolve) => { signalReached = resolve; });
  const released = new Promise((resolve) => { releaseUpdate = resolve; });
  const wrapped = new Proxy(collection, {
    get(target, property) {
      if (property === "updateOne") {
        return async (...args) => {
          if (!delayed) {
            delayed = true;
            signalReached();
            await released;
          }
          return target.updateOne(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { collection: wrapped, reached, release: releaseUpdate };
}

function delayedFirstOperation(collection, operation) {
  let signalReached;
  let releaseOperation;
  let delayed = false;
  const reached = new Promise((resolve) => { signalReached = resolve; });
  const released = new Promise((resolve) => { releaseOperation = resolve; });
  const wrapped = new Proxy(collection, {
    get(target, property) {
      if (property !== operation) {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args) => {
        if (!delayed) {
          delayed = true;
          signalReached();
          await released;
        }
        return target[operation](...args);
      };
    },
  });
  return { collection: wrapped, reached, release: releaseOperation };
}
