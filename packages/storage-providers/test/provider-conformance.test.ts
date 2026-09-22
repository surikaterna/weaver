import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConfigurationStorageProvider,
  WriteResult,
} from "@weaver-conf/config-types";
import type { Collection } from "mongodb";
import { createFileSystemStorageProvider } from "../src/fs-provider.js";
import type { GitManager } from "../src/git-manager.js";
import { createGitStorageProvider } from "../src/git-storage-provider.js";
import { createInMemoryStorageProvider } from "../src/in-memory-provider.js";
import { createMongoDBStorageProvider } from "../src/mongodb-storage-provider.js";

interface ProviderHarness {
  readonly provider: ConfigurationStorageProvider;
  reload(): Promise<ConfigurationStorageProvider>;
}

type ProviderHarnessFactory = () => Promise<ProviderHarness>;

interface ConfigDoc {
  _id?: unknown;
  layer: string;
  environment: string;
  key: string;
  value: unknown;
  updatedAt: string;
  _weaverMutationVersion?: unknown;
  _weaverMutationToken?: unknown;
}

interface KeyRegexFilter {
  $regex: string;
}

interface MongoFilter {
  _id?: MutationFilter;
  layer?: string;
  environment?: string;
  key?: string | KeyRegexFilter;
  value?: MutationFilter;
  updatedAt?: MutationFilter;
  _weaverMutationVersion?: MutationFilter;
  _weaverMutationToken?: MutationFilter;
  $or?: ReadonlyArray<{ key: string | KeyRegexFilter }>;
}

type MutationFilter = unknown | { $exists: false } | { $eq: unknown };

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempRoots.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.each([
  ["filesystem", createFileSystemHarness],
  ["git", createGitHarness],
  ["memory", createMemoryHarness],
  ["mongodb", createMongoHarness],
] as const)("%s storage provider nested object conformance", (_name, createHarness) => {
  it("round-trips an object written at an anchor", () =>
    assertAnchorRoundTrip(createHarness));
  it("persists patch results as the whole nested anchor object", () =>
    assertAnchorReplacement(createHarness));
  it("materializes nested writes instead of flat leaf records", () =>
    assertNestedWrites(createHarness));
  it("round-trips protected registry metadata through provider writes", () =>
    assertRegistryMetadata(createHarness));
  it("removes nested leaves and whole anchors without leaving flat records", () =>
    assertNestedRemoval(createHarness));
});

async function assertAnchorRoundTrip(
  createHarness: ProviderHarnessFactory,
): Promise<void> {
  const { provider, reload } = await createHarness();
  const billing = { plan: "starter", limits: { seats: 5 } };
  await expectSuccess(provider.write("billing", billing));
  expect((await (await reload()).load()).entries.billing).toEqual(billing);
}

async function assertAnchorReplacement(
  createHarness: ProviderHarnessFactory,
): Promise<void> {
  const { provider, reload } = await createHarness();
  const updated = { plan: "pro", limits: { seats: 10 } };
  await expectSuccess(
    provider.write("billing", { plan: "starter", limits: { seats: 5 } }),
  );
  await expectSuccess(provider.write("billing", updated));
  const entries = (await (await reload()).load()).entries;
  expect(entries.billing).toEqual(updated);
  expect(entries["billing.plan"]).toBe(undefined);
}

async function assertNestedWrites(
  createHarness: ProviderHarnessFactory,
): Promise<void> {
  const { provider, reload } = await createHarness();
  await expectSuccess(provider.write("billing.plan", "pro"));
  await expectSuccess(provider.write("billing.limits.seats", 10));
  const entries = (await (await reload()).load()).entries;
  expect(entries.billing).toEqual({ plan: "pro", limits: { seats: 10 } });
  expect(entries["billing.plan"]).toBe(undefined);
}

async function assertRegistryMetadata(
  createHarness: ProviderHarnessFactory,
): Promise<void> {
  const { provider, reload } = await createHarness();
  const metadata = {
    environments: { default: { schemas: { "/lynx": { kind: "service" } } } },
  };
  await expectSuccess(provider.write("_weaver.registry.schemas", metadata));
  expect((await (await reload()).load()).entries._weaver).toEqual({
    registry: { schemas: metadata },
  });
}

async function assertNestedRemoval(
  createHarness: ProviderHarnessFactory,
): Promise<void> {
  const { provider, reload } = await createHarness();
  await expectSuccess(
    provider.write("billing", { plan: "pro", limits: { seats: 10 } }),
  );
  await expectSuccess(provider.remove("billing.limits.seats"));
  expect((await (await reload()).load()).entries.billing).toEqual({
    plan: "pro",
    limits: {},
  });
  await expectSuccess(provider.remove("billing"));
  expect((await (await reload()).load()).entries.billing).toBe(undefined);
}

async function expectSuccess(
  resultPromise: Promise<WriteResult>,
): Promise<void> {
  const result = await resultPromise;
  expect(result.success).toBe(true);
  expect(result.error?.message).toBe(undefined);
}

async function createFileSystemHarness(): Promise<ProviderHarness> {
  const root = await createTempRoot("weaver-fs-conformance");
  const filePath = join(root, "config.json");
  return {
    provider: createFileSystemStorageProvider({
      id: "fs",
      layer: "app",
      filePath,
      writable: true,
    }),
    async reload() {
      return createFileSystemStorageProvider({
        id: "fs",
        layer: "app",
        filePath,
        writable: true,
      });
    },
  };
}

async function createGitHarness(): Promise<ProviderHarness> {
  const root = await createTempRoot("weaver-git-conformance");
  const gitManager = createNoopGitManager(root);
  return {
    provider: createGitStorageProvider({
      id: "git",
      layer: "app",
      gitManager,
      filePath: "config.json",
    }),
    async reload() {
      return createGitStorageProvider({
        id: "git",
        layer: "app",
        gitManager,
        filePath: "config.json",
      });
    },
  };
}

async function createMemoryHarness(): Promise<ProviderHarness> {
  const provider = createInMemoryStorageProvider({
    id: "memory",
    layer: "app",
  });
  return {
    provider,
    async reload() {
      return provider;
    },
  };
}

async function createMongoHarness(): Promise<ProviderHarness> {
  const collection = createMockCollection();
  return {
    provider: createMongoDBStorageProvider({
      id: "mongo",
      layer: "app",
      collection,
      environment: "test",
    }),
    async reload() {
      return createMongoDBStorageProvider({
        id: "mongo",
        layer: "app",
        collection,
        environment: "test",
      });
    },
  };
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = join(tmpdir(), `${prefix}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function createNoopGitManager(localPath: string): GitManager {
  return {
    localPath,
    async ensureClone() {
      return { success: true, data: undefined };
    },
    async refresh() {
      return { success: true, data: undefined };
    },
    async commitAndPush() {
      return { success: true, data: undefined };
    },
    async revert() {
      return { success: true, data: { revertedCommits: 0 } };
    },
  };
}

function createMockCollection(): Collection {
  const docs: ConfigDoc[] = [];
  const collection = {
    find(filter: MongoFilter) {
      let results = docs.filter((doc) => matchesFilter(doc, filter));
      return {
        maxTimeMS() {
          return this;
        },
        limit(count: number) {
          results = results.slice(0, count);
          return this;
        },
        toArray: () => Promise.resolve(results),
      };
    },
    async updateOne(
      filter: MongoFilter,
      update: { $set: Partial<ConfigDoc>; $unset?: Record<string, string> },
    ) {
      const index = docs.findIndex((doc) => matchesFilter(doc, filter));
      if (index >= 0) {
        const existing = docs[index];
        if (existing !== undefined) {
          docs[index] = { ...existing, ...update.$set };
          if (update.$unset?._weaverMutationVersion !== undefined) {
            delete docs[index]?._weaverMutationVersion;
          }
        }
        return { matchedCount: 1 };
      }
      return { matchedCount: 0 };
    },
    async insertOne(doc: ConfigDoc) {
      if (docs.some((existing) => String(existing._id) === String(doc._id))) {
        throw Object.assign(new Error("duplicate key"), { code: 11000 });
      }
      docs.push({ ...doc });
      return { acknowledged: true, insertedId: doc._id };
    },
    async deleteOne(filter: MongoFilter) {
      const index = docs.findIndex((doc) => matchesFilter(doc, filter));
      if (index >= 0) docs.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    },
    async deleteMany(filter: MongoFilter) {
      for (let index = docs.length - 1; index >= 0; index -= 1) {
        if (matchesFilter(docs[index], filter)) docs.splice(index, 1);
      }
    },
  };
  // The conformance fake implements exactly the Collection methods exercised by
  // the provider; real-driver behavior is covered by the live MongoDB suite.
  return collection as unknown as Collection;
}

function matchesFilter(
  doc: ConfigDoc | undefined,
  filter: MongoFilter,
): boolean {
  if (doc === undefined) return false;
  if (!matchesId(doc, filter)) return false;
  if (filter.layer !== undefined && doc.layer !== filter.layer) return false;
  if (
    filter.environment !== undefined &&
    doc.environment !== filter.environment
  )
    return false;
  if (!matchesMutationField(doc, filter, "_weaverMutationVersion"))
    return false;
  if (!matchesMutationField(doc, filter, "updatedAt")) return false;
  if (!matchesMutationField(doc, filter, "value")) return false;
  if (!matchesMutationField(doc, filter, "_weaverMutationToken")) return false;
  if (filter.$or !== undefined)
    return filter.$or.some((clause) => matchesKey(doc.key, clause.key));
  return filter.key === undefined || matchesKey(doc.key, filter.key);
}

function matchesId(doc: ConfigDoc, filter: MongoFilter): boolean {
  const condition = filter._id;
  if (
    typeof condition === "object" &&
    condition !== null &&
    "$in" in condition &&
    Array.isArray(condition.$in)
  ) {
    return condition.$in.some(
      (id: unknown) => JSON.stringify(id) === JSON.stringify(doc._id),
    );
  }
  return matchesMutationField(doc, filter, "_id");
}

function matchesMutationField(
  doc: ConfigDoc,
  filter: MongoFilter,
  key:
    | "_id"
    | "updatedAt"
    | "value"
    | "_weaverMutationVersion"
    | "_weaverMutationToken",
): boolean {
  const condition = filter[key];
  if (condition === undefined) return true;
  if (typeof condition !== "object" || condition === null) {
    return doc[key] === condition;
  }
  if ("$exists" in condition) return !Object.hasOwn(doc, key);
  if ("$eq" in condition) {
    return JSON.stringify(doc[key]) === JSON.stringify(condition.$eq);
  }
  return false;
}

function matchesKey(key: string, filter: string | KeyRegexFilter): boolean {
  if (typeof filter === "string") return key === filter;
  return new RegExp(filter.$regex).test(key);
}
