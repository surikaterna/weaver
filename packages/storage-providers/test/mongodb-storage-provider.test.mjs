import { createMongoDBStorageProvider } from "../src/mongodb-storage-provider.ts";

function createMockCollection() {
  const docs = [];

  return {
    docs,
    find(filter, options) {
      const results = docs
        .filter(
          (d) =>
            d.layer === filter.layer &&
            d.environment === filter.environment &&
            (filter.key === undefined || new RegExp(filter.key.$regex).test(d.key)),
        )
        .map((doc) => options?.projection ? { key: doc.key } : doc);
      return {
        maxTimeMS() { return this; },
        toArray: () => Promise.resolve(results),
      };
    },
    async updateOne(filter, update, options) {
      const idx = docs.findIndex(
        (d) => matchesDocument(d, filter),
      );
      if (idx >= 0) {
        Object.assign(docs[idx], update.$set);
        return { matchedCount: 1 };
      } else if (options?.upsert) {
        docs.push({ ...filter, ...update.$set });
      }
      return { matchedCount: 0 };
    },
    async insertOne(doc) {
      if (docs.some((existing) => String(existing._id) === String(doc._id))) {
        throw Object.assign(new Error("duplicate key"), { code: 11000 });
      }
      docs.push({ ...doc });
      return { acknowledged: true, insertedId: doc._id };
    },
    async deleteOne(filter) {
      const idx = docs.findIndex(
        (d) => d.layer === filter.layer && d.environment === filter.environment && d.key === filter.key,
      );
      if (idx >= 0) docs.splice(idx, 1);
    },
    async deleteMany(filter) {
      for (let index = docs.length - 1; index >= 0; index -= 1) {
        const doc = docs[index];
        const keys = filter.$or?.map((clause) => clause.key) ?? [filter.key];
        const keyMatches = keys.some((keyFilter) => {
          if (keyFilter === undefined) return true;
          if (typeof keyFilter === "string") return doc.key === keyFilter;
          return new RegExp(keyFilter.$regex).test(doc.key);
        });
        if (doc.layer === filter.layer && doc.environment === filter.environment && keyMatches) {
          docs.splice(index, 1);
        }
      }
    },
  };
}

function matchesDocument(doc, filter) {
  if (filter._id !== undefined && String(doc._id) !== String(filter._id)) {
    return false;
  }
  if (filter.layer !== undefined && doc.layer !== filter.layer) return false;
  if (filter.environment !== undefined && doc.environment !== filter.environment) {
    return false;
  }
  if (filter.key !== undefined && doc.key !== filter.key) return false;
  if (filter._weaverMutationVersion?.$exists === false) {
    return doc._weaverMutationVersion === undefined;
  }
  return filter._weaverMutationVersion === undefined ||
    doc._weaverMutationVersion === filter._weaverMutationVersion;
}

test("load() returns entries from collection", async () => {
  const col = createMockCollection();
  col.docs.push(
    { layer: "user", environment: "prod", key: "theme", value: "dark", updatedAt: "2024-01-01" },
    { layer: "user", environment: "prod", key: "lang", value: "en", updatedAt: "2024-01-01" },
    { layer: "other", environment: "prod", key: "x", value: 1, updatedAt: "2024-01-01" },
  );

  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
  });

  const data = await provider.load();
  expect(data.entries).toEqual({ theme: "dark", lang: "en" });
});

test("write() upserts document", async () => {
  const col = createMockCollection();
  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
  });

  const result = await provider.write("theme", "light");
  expect(result.success).toBe(true);
  expect(col.docs.length).toBe(1);
  expect(col.docs[0].value).toBe("light");

  // Upsert overwrites
  await provider.write("theme", "dark");
  expect(col.docs.length).toBe(1);
  expect(col.docs[0].value).toBe("dark");
});

test("write() canonicalizes nested paths into a root object document", async () => {
  const col = createMockCollection();
  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
  });

  await provider.write("billing.plan", "pro");
  await provider.write("billing.limits.seats", 10);

  expect(col.docs).toHaveLength(1);
  expect(col.docs[0].key).toBe("billing");
  expect(col.docs[0].value).toEqual({ plan: "pro", limits: { seats: 10 } });
  expect((await provider.load()).entries.billing).toEqual({
    plan: "pro",
    limits: { seats: 10 },
  });
});

test("nested mutations preserve literal dotted root segments", async () => {
  const col = createMockCollection();
  const provider = createProvider(col, "mongo-literal");

  expect((await provider.write("[billing.plan].tier", "pro")).success).toBe(true);
  expect((await provider.write("[billing.plan].limits.seats", 10)).success).toBe(true);

  expect(col.docs).toHaveLength(1);
  expect(col.docs[0].key).toBe("[billing.plan]");
  expect((await provider.load()).entries).toEqual({
    "billing.plan": { tier: "pro", limits: { seats: 10 } },
  });
});

test("concurrent providers retry a first-root insert without losing disjoint writes", async () => {
  const col = createMockCollection();
  const firstInsert = deferred();
  const releaseFirst = deferred();
  const insertOne = col.insertOne;
  let insertCalls = 0;
  col.insertOne = async (doc) => {
    insertCalls += 1;
    if (insertCalls === 1) {
      firstInsert.resolve();
      await releaseFirst.promise;
    } else {
      const result = await insertOne(doc);
      releaseFirst.resolve();
      return result;
    }
    return insertOne(doc);
  };
  const first = createProvider(col, "mongo-first");
  const second = createProvider(col, "mongo-second");

  const planWrite = first.write("billing.plan", "pro");
  await firstInsert.promise;
  const results = await Promise.all([
    planWrite,
    second.write("billing.limits.seats", 10),
  ]);

  expect(results.every((result) => result.success)).toBe(true);
  expect(insertCalls).toBe(2);
  expect((await createProvider(col, "mongo-reload").load()).entries.billing)
    .toEqual({ plan: "pro", limits: { seats: 10 } });
});

test("same-leaf conflicts use last committed mutation wins semantics", async () => {
  const col = createMockCollection();
  const firstInsert = deferred();
  const releaseFirst = deferred();
  const insertOne = col.insertOne;
  let insertCalls = 0;
  col.insertOne = async (doc) => {
    insertCalls += 1;
    if (insertCalls === 1) {
      firstInsert.resolve();
      await releaseFirst.promise;
    } else {
      const result = await insertOne(doc);
      releaseFirst.resolve();
      return result;
    }
    return insertOne(doc);
  };
  const first = createProvider(col, "mongo-first");
  const second = createProvider(col, "mongo-second");

  const firstWrite = first.write("billing.plan", "first-committed-last");
  await firstInsert.promise;
  const results = await Promise.all([
    firstWrite,
    second.write("billing.plan", "second-committed-first"),
  ]);

  expect(results.every((result) => result.success)).toBe(true);
  expect((await first.load()).entries.billing).toEqual({
    plan: "first-committed-last",
  });
});

test("concurrent nested write and remove preserve both committed mutations", async () => {
  const col = createMockCollection();
  const setup = createProvider(col, "mongo-setup");
  await setup.write("billing", { plan: "starter", limits: { seats: 5 } });
  const firstUpdate = deferred();
  const releaseFirst = deferred();
  const updateOne = col.updateOne;
  let updateCalls = 0;
  col.updateOne = async (...args) => {
    updateCalls += 1;
    if (updateCalls === 1) {
      firstUpdate.resolve();
      await releaseFirst.promise;
    } else if (updateCalls === 2) {
      const result = await updateOne(...args);
      releaseFirst.resolve();
      return result;
    }
    return updateOne(...args);
  };
  const first = createProvider(col, "mongo-first");
  const second = createProvider(col, "mongo-second");

  const write = first.write("billing.limits.seats", 10);
  await firstUpdate.promise;
  const results = await Promise.all([write, second.remove("billing.plan")]);

  expect(results.every((result) => result.success)).toBe(true);
  expect(updateCalls).toBe(3);
  expect((await first.load()).entries.billing).toEqual({
    limits: { seats: 10 },
  });
});

test("concurrent disjoint removes retry without resurrecting either leaf", async () => {
  const col = createMockCollection();
  const setup = createProvider(col, "mongo-setup");
  await setup.write("billing", { plan: "pro", limits: { seats: 10 } });
  const firstUpdate = deferred();
  const releaseFirst = deferred();
  const updateOne = col.updateOne;
  let updateCalls = 0;
  col.updateOne = async (...args) => {
    updateCalls += 1;
    if (updateCalls === 1) {
      firstUpdate.resolve();
      await releaseFirst.promise;
    } else if (updateCalls === 2) {
      const result = await updateOne(...args);
      releaseFirst.resolve();
      return result;
    }
    return updateOne(...args);
  };
  const first = createProvider(col, "mongo-first");
  const second = createProvider(col, "mongo-second");

  const removePlan = first.remove("billing.plan");
  await firstUpdate.promise;
  const results = await Promise.all([
    removePlan,
    second.remove("billing.limits.seats"),
  ]);

  expect(results.every((result) => result.success)).toBe(true);
  expect(updateCalls).toBe(3);
  expect((await first.load()).entries.billing).toEqual({ limits: {} });
});

test("root mutation conflict retries are bounded and return a typed failure", async () => {
  const col = createMockCollection();
  const provider = createProvider(col, "mongo-user");
  await provider.write("billing", { plan: "starter" });
  let updateCalls = 0;
  col.updateOne = async () => {
    updateCalls += 1;
    return { matchedCount: 0 };
  };

  const result = await provider.write("billing.plan", "pro");

  expect(result.success).toBe(false);
  expect(result.error.code).toBe("WRITE_ERROR");
  expect(result.error.message).toMatch(/conflict.*after 5 attempts/);
  expect(updateCalls).toBe(5);
  expect((await provider.load()).entries.billing).toEqual({ plan: "starter" });
});

test("write() succeeds when stale descendant cleanup fails", async () => {
  const col = createMockCollection();
  col.docs.push({
    layer: "user",
    environment: "prod",
    key: "billing.plan",
    value: "stale",
    updatedAt: "9999-01-01",
  });
  col.deleteMany = () => Promise.reject(new Error("cleanup timeout"));
  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });

  expect((await provider.write("billing.plan", "pro")).success).toBe(true);
  expect((await provider.write("billing.limits.seats", 10)).success).toBe(true);
  expect((await provider.load()).entries.billing).toEqual({
    plan: "pro",
    limits: { seats: 10 },
  });
  expect(col.docs.some((doc) => doc.key === "billing.plan")).toBe(true);
});

test("cleanup discovers candidates with a narrowed key-only query", async () => {
  const col = createMockCollection();
  const queries = [];
  const find = col.find;
  col.find = (filter, options) => {
    queries.push({ filter, options });
    return find(filter, options);
  };
  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
  });

  expect((await provider.write("billing", { plan: "pro" })).success).toBe(true);
  const cleanupQueries = queries.filter((query) => query.filter.key !== undefined);
  expect(cleanupQueries).toHaveLength(1);
  const cleanupQuery = cleanupQueries[0];
  expect(cleanupQuery.filter.key.$regex).toMatch(/^\^/);
  expect(cleanupQuery.filter.key.$regex).toContain("billing");
  expect(cleanupQuery.options).toEqual({ projection: { _id: 0, key: 1 } });
  expect(cleanupQuery.filter).not.toEqual({ layer: "user", environment: "prod" });
});

test("load() hydrates legacy dotted documents as nested objects", async () => {
  const col = createMockCollection();
  col.docs.push(
    { layer: "user", environment: "prod", key: "billing.plan", value: "pro", updatedAt: "2024-01-01" },
    { layer: "user", environment: "prod", key: "billing.limits.seats", value: 10, updatedAt: "2024-01-02" },
  );

  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
  });

  expect((await provider.load()).entries.billing).toEqual({
    plan: "pro",
    limits: { seats: 10 },
  });
});

test("load() treats noncanonical root aliases as authoritative", async () => {
  const col = createMockCollection();
  col.docs.push(
    { layer: "user", environment: "prod", key: "[billing]", value: { plan: "new" }, updatedAt: "2024-01-01" },
    { layer: "user", environment: "prod", key: "billing.plan", value: "stale", updatedAt: "9999-01-01" },
  );
  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
  });

  expect((await provider.load()).entries.billing).toEqual({ plan: "new" });
});

test("remove() updates MongoDB root object document for nested paths", async () => {
  const col = createMockCollection();
  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
  });

  await provider.write("billing", { plan: "pro", limits: { seats: 10 } });
  const result = await provider.remove("billing.limits.seats");

  expect(result.success).toBe(true);
  expect(col.docs).toHaveLength(1);
  expect(col.docs[0].key).toBe("billing");
  expect(col.docs[0].value).toEqual({ plan: "pro", limits: {} });
});

test("nested remove succeeds without resurrecting stale descendants when cleanup fails", async () => {
  const col = createMockCollection();
  col.docs.push(
    {
      layer: "user",
      environment: "prod",
      key: "billing",
      value: { plan: "pro", limits: { seats: 10 } },
      updatedAt: "2024-01-01",
    },
    {
      layer: "user",
      environment: "prod",
      key: "billing.plan",
      value: "stale",
      updatedAt: "9999-01-01",
    },
  );
  col.deleteMany = () => Promise.reject(new Error("cleanup timeout"));
  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });

  expect((await provider.remove("billing.plan")).success).toBe(true);
  expect((await provider.load()).entries.billing).toEqual({
    limits: { seats: 10 },
  });
  expect(col.docs.some((doc) => doc.key === "billing.plan")).toBe(true);
});

test("remove() deletes document", async () => {
  const col = createMockCollection();
  col.docs.push({ layer: "user", environment: "prod", key: "theme", value: "dark", updatedAt: "x" });

  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
  });

  const result = await provider.remove("theme");
  expect(result.success).toBe(true);
  expect(col.docs.length).toBe(0);
});

for (const key of ["billing", "[billing]"]) {
  test(`remove(${key}) deletes equivalent root aliases and descendants`, async () => {
    const col = createMockCollection();
    col.docs.push(
      { layer: "user", environment: "prod", key: "[billing]", value: { plan: "new" }, updatedAt: "2024-01-01" },
      { layer: "user", environment: "prod", key: "billing.plan", value: "stale", updatedAt: "9999-01-01" },
      { layer: "user", environment: "prod", key: "billing[limits]", value: { seats: 10 }, updatedAt: "9999-01-02" },
    );
    const provider = createMongoDBStorageProvider({
      id: "mongo-user",
      layer: "user",
      collection: col,
      environment: "prod",
    });

    expect((await provider.remove(key)).success).toBe(true);
    expect(col.docs).toHaveLength(0);
    expect((await provider.load()).entries).toEqual({});
  });
}

test("read-only provider rejects writes", async () => {
  const col = createMockCollection();
  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
    writable: false,
  });

  const result = await provider.write("x", 1);
  expect(result.success).toBe(false);
});

test("load() throws with descriptive error when collection fails", async () => {
  const col = createMockCollection();
  col.find = () => ({
    maxTimeMS() { return this; },
    toArray: () => Promise.reject(new Error("connection timed out")),
  });

  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });

  await expect(provider.load()).rejects.toThrow(/MongoDB load failed/);
  await expect(provider.load()).rejects.toThrow(/connection timed out/);
});

test("write() returns error result when collection fails", async () => {
  const col = createMockCollection();
  col.insertOne = () => Promise.reject(new Error("write timeout"));

  const provider = createMongoDBStorageProvider({
    id: "mongo-user",
    layer: "user",
    collection: col,
    environment: "prod",
  });

  const result = await provider.write("key", "val");
  expect(result.success).toBe(false);
  expect(result.error.message).toMatch(/write timeout/);
});

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
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
