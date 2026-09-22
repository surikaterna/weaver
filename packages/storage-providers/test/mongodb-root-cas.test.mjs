import { createMongoDBStorageProvider } from "../src/mongodb-storage-provider.ts";

test("stale writers retry after delete and recreation without overwriting recreated fields", async () => {
  const collection = createCollection();
  const setup = createProvider(collection, "setup");
  expect((await setup.write("billing", { base: true })).success).toBe(true);
  const firstUpdate = deferred();
  const releaseUpdate = deferred();
  const updateOne = collection.updateOne;
  let updateCalls = 0;
  collection.updateOne = async (...args) => {
    updateCalls += 1;
    if (updateCalls === 1) {
      firstUpdate.resolve();
      await releaseUpdate.promise;
    }
    return updateOne(...args);
  };
  const stale = createProvider(collection, "stale");
  const recreator = createProvider(collection, "recreator");

  const staleWrite = stale.write("billing.a", 1);
  await firstUpdate.promise;
  expect((await recreator.remove("billing")).success).toBe(true);
  expect((await recreator.write("billing.c", 3)).success).toBe(true);
  releaseUpdate.resolve();

  expect((await staleWrite).success).toBe(true);
  expect(updateCalls).toBe(2);
  expect((await setup.load()).entries.billing).toEqual({ c: 3, a: 1 });
});

test.each([
  ["missing metadata", {}],
  ["legacy version", { _weaverMutationVersion: 7 }],
  ["malformed token", { _weaverMutationToken: 7 }],
])("migrates %s to a fresh mutation token", async (_name, metadata) => {
  const collection = createCollection();
  collection.docs.push(stored({ plan: "starter" }, metadata));

  const result = await createProvider(collection, "migration").write(
    "billing.plan",
    "pro",
  );

  expect(result.success).toBe(true);
  expect(collection.docs[0]._weaverMutationToken).toMatch(UUID_PATTERN);
  expect(collection.docs[0]).not.toHaveProperty("_weaverMutationVersion");
  expect(collection.docs[0].value).toEqual({ plan: "pro" });
});

test("overflowing legacy versions migrate without reset or token reuse", async () => {
  const collection = createCollection();
  collection.docs.push(stored({ plan: "starter" }, {
    _weaverMutationVersion: Number.MAX_SAFE_INTEGER,
  }));
  const provider = createProvider(collection, "overflow");

  expect((await provider.write("billing.plan", "pro")).success).toBe(true);
  const firstToken = collection.docs[0]._weaverMutationToken;
  expect((await provider.write("billing.seats", 10)).success).toBe(true);
  const secondToken = collection.docs[0]._weaverMutationToken;
  expect((await provider.remove("billing")).success).toBe(true);
  expect((await provider.write("billing.region", "eu")).success).toBe(true);
  const recreatedToken = collection.docs[0]._weaverMutationToken;

  expect([firstToken, secondToken, recreatedToken]).toEqual([
    expect.stringMatching(UUID_PATTERN),
    expect.stringMatching(UUID_PATTERN),
    expect.stringMatching(UUID_PATTERN),
  ]);
  expect(new Set([firstToken, secondToken, recreatedToken]).size).toBe(3);
  expect(collection.docs[0]).not.toHaveProperty("_weaverMutationVersion");
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createCollection() {
  const docs = [];
  return {
    docs,
    find(filter, options) {
      const matches = docs.filter((doc) =>
        doc.layer === filter.layer && doc.environment === filter.environment &&
        matchesKey(doc, filter.key));
      const results = matches.map((doc) =>
        options?.projection ? { key: doc.key } : doc);
      return { maxTimeMS() { return this; }, toArray: async () => results };
    },
    async updateOne(filter, update) {
      const doc = docs.find((candidate) => matchesDocument(candidate, filter));
      if (doc === undefined) return { matchedCount: 0 };
      Object.assign(doc, update.$set);
      for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
      return { matchedCount: 1 };
    },
    async insertOne(doc) {
      if (docs.some((existing) => existing._id === doc._id)) {
        throw Object.assign(new Error("duplicate key"), { code: 11000 });
      }
      docs.push({ ...doc });
      return { acknowledged: true, insertedId: doc._id };
    },
    async deleteOne(filter) {
      const index = docs.findIndex((doc) => matchesDocument(doc, filter));
      if (index >= 0) docs.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    },
    async deleteMany(filter) {
      const keys = filter.$or.map((clause) => clause.key);
      for (let index = docs.length - 1; index >= 0; index -= 1) {
        const doc = docs[index];
        if (doc.layer === filter.layer && doc.environment === filter.environment &&
          keys.includes(doc.key)) docs.splice(index, 1);
      }
      return { deletedCount: 0 };
    },
  };
}

function matchesDocument(doc, filter) {
  if (filter._id !== undefined && doc._id !== filter._id) return false;
  const expectedId = filter.$expr?.$eq?.[1];
  if (expectedId !== undefined && doc._id !== expectedId) return false;
  return matchesField(doc, filter, "_weaverMutationToken") &&
    matchesField(doc, filter, "_weaverMutationVersion");
}

function matchesField(doc, filter, key) {
  const condition = filter[key];
  if (condition === undefined) return true;
  if (condition.$exists === false) return !Object.hasOwn(doc, key);
  return doc[key] === condition.$eq;
}

function matchesKey(doc, condition) {
  if (condition === undefined) return true;
  return new RegExp(condition.$regex).test(doc.key);
}

function stored(value, metadata) {
  return {
    _id: `legacy-${JSON.stringify(metadata)}`,
    layer: "user",
    environment: "prod",
    key: "billing",
    value,
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...metadata,
  };
}

function createProvider(collection, id) {
  return createMongoDBStorageProvider({
    id,
    layer: "user",
    collection,
    environment: "prod",
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}
