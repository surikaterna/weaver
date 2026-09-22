import { ObjectId } from "mongodb";
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

test("whole-root removal deletes legacy and deterministic exact duplicates", async () => {
  const collection = createCollection();
  const provider = createProvider(collection, "duplicate-remover");
  expect((await provider.write("billing", { current: true })).success).toBe(true);
  collection.docs.unshift(stored({ old: true }, {}, new ObjectId()));

  expect((await provider.remove("billing")).success).toBe(true);

  expect(collection.docs.filter((doc) => doc.key === "billing")).toEqual([]);
  expect((await provider.load()).entries.billing).toBeUndefined();
});

test.each([
  ["absent", {}],
  ["malformed", { _weaverMutationToken: 42 }],
  ["numeric", { _weaverMutationVersion: 7 }],
])("whole-root removal compares %s mutation metadata", async (_name, metadata) => {
  const collection = createCollection();
  collection.docs.push(stored({ old: true }, metadata));

  expect((await createProvider(collection, "legacy-remover").remove("billing")).success)
    .toBe(true);
  expect(collection.docs).toEqual([]);
});

test("whole-root removal preserves a fresh generation after observing duplicates", async () => {
  const collection = createCollection();
  const setup = createProvider(collection, "duplicate-setup");
  expect((await setup.write("billing", { current: true })).success).toBe(true);
  collection.docs.unshift(stored({ old: true }, {}, new ObjectId()));
  const gate = delayedFirstDelete(collection);
  const remover = createProvider(gate.collection, "duplicate-remover");
  const recreator = createProvider(collection, "duplicate-recreator");

  const removal = remover.remove("billing");
  await gate.reached;
  expect((await recreator.remove("billing")).success).toBe(true);
  expect((await recreator.write("billing", { fresh: true })).success).toBe(true);
  gate.release();

  expect((await removal).success).toBe(true);
  expect((await setup.load()).entries.billing).toEqual({ fresh: true });
  expect(collection.docs.filter((doc) => doc.key === "billing")).toHaveLength(1);
});

test("alias cleanup preserves a descendant recreated after discovery", async () => {
  const collection = createCollection();
  collection.docs.push({
    ...stored("old", {}, "legacy-descendant"),
    key: "billing.plan",
  });
  const gate = delayedFirstDelete(collection);
  const remover = createProvider(gate.collection, "alias-remover");

  const removal = remover.remove("billing");
  await gate.reached;
  await collection.deleteOne({ _id: "legacy-descendant" });
  collection.docs.push({
    ...stored("fresh", { _weaverMutationToken: "fresh-token" }, "legacy-descendant"),
    key: "billing.plan",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  gate.release();

  expect((await removal).success).toBe(true);
  expect((await createProvider(collection, "alias-reload").load()).entries.billing)
    .toEqual({ plan: "fresh" });
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
        options?.projection ? projectDocument(doc, options.projection) : doc);
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
  if (!matchesField(doc, filter, "_id")) return false;
  const expectedId = filter.$expr?.$eq?.[1];
  if (expectedId !== undefined && doc._id !== expectedId) return false;
  return matchesField(doc, filter, "updatedAt") &&
    matchesField(doc, filter, "value") &&
    matchesField(doc, filter, "_weaverMutationToken") &&
    matchesField(doc, filter, "_weaverMutationVersion");
}

function matchesField(doc, filter, key) {
  const condition = filter[key];
  if (condition === undefined) return true;
  if (condition !== null && typeof condition === "object") {
    if (condition.$exists === false) return !Object.hasOwn(doc, key);
    if ("$eq" in condition) {
      return JSON.stringify(doc[key]) === JSON.stringify(condition.$eq);
    }
  }
  return JSON.stringify(doc[key]) === JSON.stringify(condition);
}

function matchesKey(doc, condition) {
  if (condition === undefined) return true;
  return new RegExp(condition.$regex).test(doc.key);
}

function stored(value, metadata, id = `legacy-${JSON.stringify(metadata)}`) {
  return {
    _id: id,
    layer: "user",
    environment: "prod",
    key: "billing",
    value,
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...metadata,
  };
}

function projectDocument(document, projection) {
  return Object.fromEntries(
    Object.keys(projection)
      .filter((key) => projection[key] === 1 && Object.hasOwn(document, key))
      .map((key) => [key, document[key]]),
  );
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

function delayedFirstDelete(collection) {
  const reached = deferred();
  const released = deferred();
  let delayed = false;
  const wrapped = new Proxy(collection, {
    get(target, property) {
      if (property !== "deleteOne") return Reflect.get(target, property, target);
      return async (...args) => {
        if (!delayed) {
          delayed = true;
          reached.resolve();
          await released.promise;
        }
        return target.deleteOne(...args);
      };
    },
  });
  return {
    collection: wrapped,
    reached: reached.promise,
    release: released.resolve,
  };
}
