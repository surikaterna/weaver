import { ObjectId } from "mongodb";
import { createMongoDBStorageProvider } from "../src/mongodb-storage-provider.ts";
import {
  MAX_MONGO_ROOT_CANDIDATES,
  snapshotMongoRoot,
} from "../src/mongodb-root-snapshot.ts";

test("root snapshots use bounded two-phase projections", async () => {
  const collection = createCollection();
  for (let index = 0; index < MAX_MONGO_ROOT_CANDIDATES; index += 1) {
    collection.docs.push({
      ...stored(index, {}, `candidate-${index}`),
      key: `billing.child${index}`,
    });
  }

  const snapshot = await snapshotMongoRoot(snapshotOptions(collection));

  expect(snapshot.documents).toHaveLength(MAX_MONGO_ROOT_CANDIDATES);
  expect(collection.queries).toHaveLength(2);
  expect(collection.queries.map((query) => query.limit)).toEqual([257, 256]);
  expect(collection.queries.map((query) => query.maxTimeMS)).toEqual([30_000, 30_000]);
  expect(collection.queries[0].filter.key.$regex).toMatch(/^\^/);
  expect(collection.queries[0].options.projection).toEqual({ _id: 1 });
  expect(collection.queries[1].filter._id.$in).toHaveLength(256);
  expect(collection.queries[1].options.projection.value).toBe(1);
});

test.each([
  ["valid descendants", (index) => `billing.child${index}`],
  ["regex false positives", () => "billing["],
])("257 %s fail before any storage effect", async (_name, keyForIndex) => {
  const collection = createCollection();
  for (let index = 0; index <= MAX_MONGO_ROOT_CANDIDATES; index += 1) {
    collection.docs.push({
      ...stored(index, {}, `candidate-${index}`),
      key: keyForIndex(index),
    });
  }
  const before = collection.docs.map((document) => ({ ...document }));

  const result = await createProvider(collection, "overflow").write("billing", {});

  expect(result).toMatchObject({ success: false, error: { code: "WRITE_ERROR" } });
  expect(result.error.message).toMatch(/256 candidate limit/);
  expect(collection.operations).toEqual({ inserts: 0, updates: 0, deletes: 0 });
  expect(collection.queries).toHaveLength(1);
  expect(collection.queries[0].limit).toBe(257);
  expect(collection.docs).toEqual(before);
});

test("root snapshots tolerate candidates deleted before exact hydration", async () => {
  const collection = createCollection();
  collection.docs.push({ ...stored("old", {}, "observed"), key: "billing.plan" });
  const find = collection.find;
  collection.find = (filter, options) => {
    const cursor = find(filter, options);
    if (filter._id === undefined) return cursor;
    cursor.toArray = async () => [];
    return cursor;
  };

  const snapshot = await snapshotMongoRoot(snapshotOptions(collection));

  expect(snapshot.documents).toEqual([]);
  expect(collection.operations).toEqual({ inserts: 0, updates: 0, deletes: 0 });
});

test("each failed root CAS refreshes both snapshot phases", async () => {
  const collection = createCollection();
  collection.docs.push(stored({ plan: "old" }, { _weaverMutationToken: "token" }, "root"));
  collection.updateOne = async () => {
    collection.operations.updates += 1;
    return { matchedCount: 0 };
  };

  const result = await createProvider(collection, "retry-refresh").write(
    "billing.plan",
    "new",
  );

  expect(result).toMatchObject({ success: false, error: { code: "WRITE_ERROR" } });
  expect(collection.operations.updates).toBe(5);
  expect(collection.queries.map((query) => query.limit)).toEqual([
    257, 256, 257, 256, 257, 256, 257, 256, 257, 256,
  ]);
});

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
  ["absent/string id", {}, "legacy-string"],
  ["malformed/ObjectId", { _weaverMutationToken: { bad: true } }, new ObjectId()],
  ["numeric/string id", { _weaverMutationVersion: 7 }, "legacy-numeric"],
  ["string/ObjectId", { _weaverMutationToken: "token" }, new ObjectId()],
])("whole-root removal compares %s mutation metadata", async (_name, metadata, id) => {
  const collection = createCollection();
  collection.docs.push(stored({ old: true }, metadata, id));

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

const observedStateMatrix = [
  ["ObjectId/missing", () => new ObjectId(), {}],
  ["ObjectId/malformed token", () => new ObjectId(), { _weaverMutationToken: { bad: true } }],
  ["string/numeric version", () => "legacy-string", { _weaverMutationVersion: 7 }],
  ["string/string token", () => "legacy-string", { _weaverMutationToken: "token" }],
];

test.each(observedStateMatrix)(
  "value-only alias rewrite survives cleanup for %s",
  async (_name, createId, metadata) => {
    const collection = createCollection();
    collection.docs.push({
      ...stored({ old: true }, metadata, createId()),
      key: "[billing]",
    });
    const gate = delayedFirstDelete(collection);
    const removal = createProvider(gate.collection, "alias-remover").remove("billing");
    await gate.reached;
    collection.docs.find((document) => document.key === "[billing]").value = {
      fresh: true,
    };
    gate.release();

    expect((await removal).success).toBe(true);
    expect((await createProvider(collection, "alias-reload").load()).entries.billing)
      .toEqual({ fresh: true });
  },
);

test("value-only descendant rewrite survives cleanup", async () => {
  const collection = createCollection();
  collection.docs.push({
    ...stored("old", {}, new ObjectId()),
    key: "billing.plan",
  });
  const gate = delayedFirstDelete(collection);
  const removal = createProvider(gate.collection, "descendant-remover").remove("billing");
  await gate.reached;
  collection.docs.find((document) => document.key === "billing.plan").value = "fresh";
  gate.release();

  expect((await removal).success).toBe(true);
  expect((await createProvider(collection, "descendant-reload").load()).entries.billing)
    .toEqual({ plan: "fresh" });
});

test("strict cleanup failure retains a canonical authority guard and retry converges", async () => {
  const collection = createCollection();
  collection.docs.push({ ...stored("pro", {}, "legacy"), key: "billing.plan" });
  const deleteOne = collection.deleteOne;
  collection.deleteOne = async () => {
    throw new Error("strict cleanup failed");
  };
  const provider = createProvider(collection, "strict-remover");

  const failed = await provider.remove("billing");

  expect(failed).toMatchObject({ success: false, error: { code: "WRITE_ERROR" } });
  expect((await provider.load()).entries.billing).toEqual({ plan: "pro" });
  expect(collection.docs.some((document) => document.key === "billing")).toBe(true);
  collection.deleteOne = deleteOne;
  expect((await provider.remove("billing")).success).toBe(true);
  expect((await provider.load()).entries).toEqual({});
  expect(collection.queries.filter((query) => query.filter.key !== undefined)).toHaveLength(2);
});

test("whole-root cleanup deletes the authority guard last", async () => {
  const collection = createCollection();
  collection.docs.push(
    {
      ...stored({ current: true }, { _weaverMutationToken: "guard" }, "guard"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    stored({ old: true }, {}, "duplicate"),
    { ...stored("stale", {}, "alias"), key: "billing.plan" },
  );
  const deletedIds = [];
  const deleteOne = collection.deleteOne;
  collection.deleteOne = async (filter) => {
    deletedIds.push(filter._id.$eq);
    return deleteOne(filter);
  };

  expect((await createProvider(collection, "ordered-remover").remove("billing")).success)
    .toBe(true);
  expect(deletedIds).toEqual(["duplicate", "alias", "guard"]);
});

test("a changed final authority guard survives its CAS miss", async () => {
  const collection = createCollection();
  collection.docs.push(
    stored({ current: true }, { _weaverMutationToken: "old" }, "guard"),
    { ...stored("stale", {}, "alias"), key: "billing.plan" },
  );
  const deleteOne = collection.deleteOne;
  collection.deleteOne = async (filter) => {
    if (filter._id.$eq === "guard") {
      const guard = collection.docs.find((document) => document._id === "guard");
      guard.value = { fresh: true };
      guard._weaverMutationToken = "fresh";
    }
    return deleteOne(filter);
  };

  expect((await createProvider(collection, "guard-remover").remove("billing")).success)
    .toBe(true);
  expect((await createProvider(collection, "guard-reload").load()).entries.billing)
    .toEqual({ fresh: true });
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createCollection() {
  const docs = [];
  const queries = [];
  const operations = { inserts: 0, updates: 0, deletes: 0 };
  return {
    docs,
    queries,
    operations,
    find(filter, options) {
      let matches = docs.filter((doc) =>
        doc.layer === filter.layer && doc.environment === filter.environment &&
        matchesKey(doc, filter.key) && matchesIds(doc, filter._id));
      const query = { filter, options, maxTimeMS: undefined, limit: undefined };
      queries.push(query);
      return {
        maxTimeMS(timeout) { query.maxTimeMS = timeout; return this; },
        limit(count) {
          query.limit = count;
          matches = matches.slice(0, count);
          return this;
        },
        toArray: async () => matches.map((doc) =>
          options?.projection ? projectDocument(doc, options.projection) : doc),
      };
    },
    async updateOne(filter, update) {
      operations.updates += 1;
      const doc = docs.find((candidate) => matchesDocument(candidate, filter));
      if (doc === undefined) return { matchedCount: 0 };
      Object.assign(doc, update.$set);
      for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
      return { matchedCount: 1 };
    },
    async insertOne(doc) {
      operations.inserts += 1;
      if (docs.some((existing) => existing._id === doc._id)) {
        throw Object.assign(new Error("duplicate key"), { code: 11000 });
      }
      docs.push({ ...doc });
      return { acknowledged: true, insertedId: doc._id };
    },
    async deleteOne(filter) {
      operations.deletes += 1;
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

function matchesIds(doc, condition) {
  if (condition === undefined) return true;
  return condition.$in.some((id) => JSON.stringify(id) === JSON.stringify(doc._id));
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

function snapshotOptions(collection) {
  return {
    collection,
    layer: "user",
    environment: "prod",
    rootKey: "billing",
    timeoutMs: 30_000,
  };
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
