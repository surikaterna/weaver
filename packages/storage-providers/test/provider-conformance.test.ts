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

interface ConfigDoc {
  layer: string;
  environment: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

interface KeyRegexFilter {
  $regex: string;
}

interface MongoFilter {
  layer: string;
  environment: string;
  key?: string | KeyRegexFilter;
  $or?: ReadonlyArray<{ key: string | KeyRegexFilter }>;
}

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
  it("round-trips an object written at an anchor", async () => {
    const { provider, reload } = await createHarness();
    const billing = { plan: "starter", limits: { seats: 5 } };

    await expectSuccess(provider.write("billing", billing));

    const reloaded = await reload();
    expect((await reloaded.load()).entries.billing).toEqual(billing);
  });

  it("persists patch results as the whole nested anchor object", async () => {
    const { provider, reload } = await createHarness();
    const updated = { plan: "pro", limits: { seats: 10 } };

    await expectSuccess(
      provider.write("billing", { plan: "starter", limits: { seats: 5 } }),
    );
    await expectSuccess(provider.write("billing", updated));

    const entries = (await (await reload()).load()).entries;
    expect(entries.billing).toEqual(updated);
    expect(entries["billing.plan"]).toBe(undefined);
  });

  it("materializes nested writes instead of flat leaf records", async () => {
    const { provider, reload } = await createHarness();

    await expectSuccess(provider.write("billing.plan", "pro"));
    await expectSuccess(provider.write("billing.limits.seats", 10));

    const entries = (await (await reload()).load()).entries;
    expect(entries.billing).toEqual({ plan: "pro", limits: { seats: 10 } });
    expect(entries["billing.plan"]).toBe(undefined);
  });

  it("round-trips protected registry metadata through provider writes", async () => {
    const { provider, reload } = await createHarness();
    const metadata = {
      environments: {
        default: { schemas: { "/lynx": { kind: "service" } } },
      },
    };

    await expectSuccess(provider.write("_weaver.registry.schemas", metadata));

    expect((await (await reload()).load()).entries._weaver).toEqual({
      registry: { schemas: metadata },
    });
  });

  it("removes nested leaves and whole anchors without leaving flat records", async () => {
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
  });
});

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
      const results = docs.filter((doc) => matchesFilter(doc, filter));
      return {
        maxTimeMS() {
          return this;
        },
        toArray: () => Promise.resolve(results),
      };
    },
    async updateOne(filter: MongoFilter, update: { $set: Partial<ConfigDoc> }) {
      const index = docs.findIndex((doc) => matchesFilter(doc, filter));
      if (index >= 0) {
        const existing = docs[index];
        if (existing !== undefined) {
          docs[index] = { ...existing, ...update.$set };
        }
        return;
      }
      docs.push({
        ...filter,
        key: String(filter.key),
        value: update.$set.value,
        updatedAt: String(update.$set.updatedAt),
      });
    },
    async deleteMany(filter: MongoFilter) {
      for (let index = docs.length - 1; index >= 0; index -= 1) {
        if (matchesFilter(docs[index], filter)) docs.splice(index, 1);
      }
    },
  };
  return collection as unknown as Collection;
}

function matchesFilter(
  doc: ConfigDoc | undefined,
  filter: MongoFilter,
): boolean {
  if (doc === undefined) return false;
  if (doc.layer !== filter.layer || doc.environment !== filter.environment)
    return false;
  if (filter.$or !== undefined)
    return filter.$or.some((clause) => matchesKey(doc.key, clause.key));
  return filter.key === undefined || matchesKey(doc.key, filter.key);
}

function matchesKey(key: string, filter: string | KeyRegexFilter): boolean {
  if (typeof filter === "string") return key === filter;
  return new RegExp(filter.$regex).test(key);
}
