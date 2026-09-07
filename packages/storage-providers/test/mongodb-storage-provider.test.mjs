import { createMongoDBStorageProvider } from "../src/mongodb-storage-provider.ts";

function createMockCollection() {
  const docs = [];

  return {
    docs,
    find(filter) {
      const results = docs.filter(
        (d) => d.layer === filter.layer && d.environment === filter.environment,
      );
      return {
        maxTimeMS() { return this; },
        toArray: () => Promise.resolve(results),
      };
    },
    async updateOne(filter, update, options) {
      const idx = docs.findIndex(
        (d) => d.layer === filter.layer && d.environment === filter.environment && d.key === filter.key,
      );
      if (idx >= 0) {
        Object.assign(docs[idx], update.$set);
      } else if (options?.upsert) {
        docs.push({ ...filter, ...update.$set });
      }
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
  col.updateOne = () => Promise.reject(new Error("write timeout"));

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
