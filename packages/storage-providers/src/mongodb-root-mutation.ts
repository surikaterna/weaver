import { createHash } from "node:crypto";
import {
  buildPath,
  cloneValue,
  deepGet,
  deepRemove,
  deepSet,
  parsePath,
} from "@weaver-conf/config-engine";
import { type Collection, type Document, type Filter, ObjectId } from "mongodb";
import { z } from "zod";
import { canonicalMongoPath } from "./mongodb-path-identity.js";

const MAX_MUTATION_ATTEMPTS = 5;

export const storedConfigDocumentSchema = z.object({
  _id: z.unknown().optional(),
  layer: z.string(),
  environment: z.string(),
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.string(),
  _weaverMutationVersion: z.unknown().optional(),
});

export type StoredConfigDocument = z.infer<typeof storedConfigDocumentSchema>;

export type RootMutation =
  | { readonly kind: "write"; readonly value: unknown }
  | { readonly kind: "remove" };

interface RootMutationOptions {
  readonly collection: Collection;
  readonly layer: string;
  readonly environment: string;
  readonly rootKey: string;
  readonly tail: readonly string[];
  readonly mutation: RootMutation;
  readonly timeoutMs: number;
}

export class MongoRootMutationConflictError extends Error {
  constructor(rootKey: string) {
    super(
      `MongoDB root mutation conflict for "${rootKey}" after ${MAX_MUTATION_ATTEMPTS} attempts`,
    );
    this.name = "MongoRootMutationConflictError";
  }
}

export async function findStoredConfigDocuments(
  collection: Collection,
  layer: string,
  environment: string,
  timeoutMs: number,
): Promise<StoredConfigDocument[]> {
  const rawDocs = await collection
    .find({ layer, environment })
    .maxTimeMS(timeoutMs)
    .toArray();
  return z.array(storedConfigDocumentSchema).parse(rawDocs);
}

export async function mutateMongoRoot(
  options: RootMutationOptions,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const docs = await findStoredConfigDocuments(
      options.collection,
      options.layer,
      options.environment,
      options.timeoutMs,
    );
    const nextValue = buildNextRootValue(options, docs);
    if (!nextValue.hasValue) return false;
    if (await commitRootValue(options, docs, nextValue.value)) return true;
  }
  throw new MongoRootMutationConflictError(options.rootKey);
}

function buildNextRootValue(
  options: RootMutationOptions,
  docs: readonly StoredConfigDocument[],
):
  | { readonly hasValue: true; readonly value: unknown }
  | { readonly hasValue: false } {
  if (options.tail.length === 0 && options.mutation.kind === "write") {
    return { hasValue: true, value: options.mutation.value };
  }
  const entries = hydrateEntries(docs);
  const existingRoot = deepGet(entries, options.rootKey);
  if (options.mutation.kind === "remove" && !isRecord(existingRoot)) {
    return { hasValue: false };
  }
  const root = isRecord(existingRoot) ? cloneValue(existingRoot) : {};
  if (options.mutation.kind === "write") {
    deepSet(root, buildPath(options.tail), options.mutation.value);
  } else {
    deepRemove(root, buildPath(options.tail));
  }
  return { hasValue: true, value: root };
}

async function commitRootValue(
  options: RootMutationOptions,
  docs: readonly StoredConfigDocument[],
  value: unknown,
): Promise<boolean> {
  const canonical = sortConfigDocuments(
    docs.filter((doc) => doc.key === options.rootKey),
  ).at(-1);
  if (canonical !== undefined) {
    return updateCanonicalRoot(options, canonical, value);
  }
  return insertCanonicalRoot(options, value);
}

async function updateCanonicalRoot(
  options: RootMutationOptions,
  canonical: StoredConfigDocument,
  value: unknown,
): Promise<boolean> {
  const version = canonical._weaverMutationVersion;
  const parsedId = z.instanceof(ObjectId).safeParse(canonical._id);
  const identity: Filter<Document> = parsedId.success
    ? { _id: parsedId.data }
    : {
        layer: options.layer,
        environment: options.environment,
        key: options.rootKey,
      };
  const filter: Filter<Document> = {
    ...identity,
    _weaverMutationVersion: Object.hasOwn(canonical, "_weaverMutationVersion")
      ? version
      : { $exists: false },
  };
  const result = await options.collection.updateOne(
    filter,
    {
      $set: {
        value,
        updatedAt: new Date().toISOString(),
        _weaverMutationVersion: nextMutationVersion(version),
      },
    },
    { upsert: false, maxTimeMS: options.timeoutMs },
  );
  return result.matchedCount === 1;
}

async function insertCanonicalRoot(
  options: RootMutationOptions,
  value: unknown,
): Promise<boolean> {
  try {
    await options.collection.insertOne(
      {
        _id: rootDocumentId(options),
        layer: options.layer,
        environment: options.environment,
        key: options.rootKey,
        value,
        updatedAt: new Date().toISOString(),
        _weaverMutationVersion: 1,
      },
      { maxTimeMS: options.timeoutMs },
    );
    return true;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

function rootDocumentId(options: RootMutationOptions): ObjectId {
  const identity = JSON.stringify([
    options.layer,
    options.environment,
    canonicalMongoPath(options.rootKey),
  ]);
  const digest = createHash("sha256").update(identity).digest("hex");
  return new ObjectId(digest.slice(0, 24));
}

function isDuplicateKeyError(error: unknown): boolean {
  return z.object({ code: z.literal(11000) }).safeParse(error).success;
}

function nextMutationVersion(version: unknown): number {
  if (
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= 0 &&
    version < Number.MAX_SAFE_INTEGER
  ) {
    return version + 1;
  }
  return 1;
}

function hydrateEntries(
  docs: readonly StoredConfigDocument[],
): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const doc of selectEffectiveDocuments(docs)) {
    deepSet(entries, doc.key, cloneValue(doc.value));
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortConfigDocuments(
  docs: readonly StoredConfigDocument[],
): StoredConfigDocument[] {
  return [...docs].sort((left, right) => {
    const dateOrder = left.updatedAt.localeCompare(right.updatedAt);
    if (dateOrder !== 0) return dateOrder;
    return parsePath(left.key).length - parsePath(right.key).length;
  });
}

export function selectEffectiveDocuments(
  docs: readonly StoredConfigDocument[],
): StoredConfigDocument[] {
  const roots = docs.filter((doc) => parsePath(doc.key).length === 1);
  const rootIdentities = new Set(
    roots.map((doc) => canonicalMongoPath(doc.key)),
  );
  const canonicalRoots = new Set(
    roots
      .filter((doc) => doc.key === canonicalMongoPath(doc.key))
      .map((doc) => doc.key),
  );
  const effectiveDocs = docs.filter((doc) => {
    const segments = parsePath(doc.key);
    if (segments.length === 1) {
      const identity = canonicalMongoPath(doc.key);
      return !canonicalRoots.has(identity) || doc.key === identity;
    }
    const root = segments[0];
    return root === undefined || !rootIdentities.has(buildPath([root]));
  });
  return sortConfigDocuments(effectiveDocs);
}
