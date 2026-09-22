import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  buildPath,
  cloneValue,
  deepGet,
  deepRemove,
  deepSet,
  parsePath,
} from "@weaver-conf/config-engine";
import type { Collection, Document } from "mongodb";
import { z } from "zod";
import {
  deleteObservedMongoDocuments,
  observedMongoDocumentFilter,
} from "./mongodb-observed-cleanup.js";
import { canonicalMongoPath } from "./mongodb-path-identity.js";
import {
  MAX_MONGO_ROOT_CANDIDATES,
  MongoRootCandidateLimitError,
  type MongoRootSnapshot,
  type ObservedMongoDocument,
  snapshotMongoRoot,
} from "./mongodb-root-snapshot.js";

const MAX_MUTATION_ATTEMPTS = 5;

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

export interface RootMutationResult {
  readonly committed: boolean;
  readonly snapshot: MongoRootSnapshot;
}

export async function mutateMongoRoot(
  options: RootMutationOptions,
): Promise<RootMutationResult> {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const snapshot = await snapshotMongoRoot(options);
    if (isWholeRootRemoval(options)) {
      if (await removeWholeRoot(options, snapshot)) {
        return { committed: true, snapshot };
      }
      continue;
    }
    const nextMutation = buildNextRootMutation(options, snapshot.documents);
    if (nextMutation.kind === "none") {
      return { committed: false, snapshot };
    }
    if (await commitRootMutation(options, snapshot, nextMutation)) {
      return { committed: true, snapshot };
    }
  }
  throw new MongoRootMutationConflictError(options.rootKey);
}

type NextRootMutation =
  | { readonly kind: "write"; readonly value: unknown }
  | { readonly kind: "none" };

function buildNextRootMutation(
  options: RootMutationOptions,
  docs: readonly ObservedMongoDocument[],
): NextRootMutation {
  if (options.tail.length === 0 && options.mutation.kind === "write") {
    return { kind: "write", value: options.mutation.value };
  }
  const entries = hydrateEntries(docs);
  const existingRoot = deepGet(entries, options.rootKey);
  if (options.mutation.kind === "remove" && !isRecord(existingRoot)) {
    return { kind: "none" };
  }
  const root = isRecord(existingRoot) ? cloneValue(existingRoot) : {};
  if (options.mutation.kind === "write") {
    deepSet(root, buildPath(options.tail), options.mutation.value);
  } else {
    deepRemove(root, buildPath(options.tail));
  }
  return { kind: "write", value: root };
}

async function commitRootMutation(
  options: RootMutationOptions,
  snapshot: MongoRootSnapshot,
  mutation: { readonly kind: "write"; readonly value: unknown },
): Promise<boolean> {
  const canonical = sortConfigDocuments(
    snapshot.documents.filter((doc) => doc.key === options.rootKey),
  ).at(-1);
  if (canonical !== undefined) {
    return updateCanonicalRoot(options, canonical, mutation.value);
  }
  if (snapshot.candidateCount >= MAX_MONGO_ROOT_CANDIDATES) {
    throw new MongoRootCandidateLimitError(options.rootKey);
  }
  const inserted = await insertCanonicalRoot(options, mutation.value);
  if (inserted === false) return false;
  if (snapshot.candidateCount === MAX_MONGO_ROOT_CANDIDATES - 1) {
    await verifyInsertedRootCapacity(options, inserted);
  }
  return true;
}

async function verifyInsertedRootCapacity(
  options: RootMutationOptions,
  inserted: ObservedMongoDocument,
): Promise<void> {
  try {
    await snapshotMongoRoot(options);
  } catch (error) {
    await options.collection.deleteOne(observedMongoDocumentFilter(inserted), {
      maxTimeMS: options.timeoutMs,
    });
    throw error;
  }
}

async function updateCanonicalRoot(
  options: RootMutationOptions,
  canonical: ObservedMongoDocument,
  value: unknown,
): Promise<boolean> {
  const result = await options.collection.updateOne(
    observedMongoDocumentFilter(canonical),
    {
      $set: {
        value,
        updatedAt: new Date().toISOString(),
        _weaverMutationToken: freshMutationToken(),
      },
      $unset: { _weaverMutationVersion: "" },
    },
    { upsert: false, maxTimeMS: options.timeoutMs },
  );
  return result.matchedCount === 1;
}

function isWholeRootRemoval(options: RootMutationOptions): boolean {
  return options.tail.length === 0 && options.mutation.kind === "remove";
}

async function removeWholeRoot(
  options: RootMutationOptions,
  snapshot: MongoRootSnapshot,
): Promise<boolean> {
  if (snapshot.documents.length === 0) return true;
  let guard = authoritativeExactRoot(options, snapshot.documents);
  let documents = snapshot.documents;
  if (guard === undefined) {
    if (snapshot.candidateCount >= MAX_MONGO_ROOT_CANDIDATES) {
      throw new MongoRootCandidateLimitError(options.rootKey);
    }
    const value = deepGet(hydrateEntries(documents), options.rootKey);
    if (value === undefined) return true;
    const inserted = await insertCanonicalRoot(options, cloneValue(value));
    if (inserted === false) return false;
    guard = inserted;
    documents = [...documents, guard];
  }
  const stale = documents.filter(
    (document) => !isDeepStrictEqual(document._id, guard._id),
  );
  await deleteObservedMongoDocuments({
    collection: options.collection,
    documents: stale,
    timeoutMs: options.timeoutMs,
  });
  await deleteObservedMongoDocuments({
    collection: options.collection,
    documents: [guard],
    timeoutMs: options.timeoutMs,
  });
  return true;
}

async function insertCanonicalRoot(
  options: RootMutationOptions,
  value: unknown,
): Promise<ObservedMongoDocument | false> {
  try {
    const document: ObservedMongoDocument = {
      _id: rootDocumentId(options),
      layer: options.layer,
      environment: options.environment,
      key: options.rootKey,
      value,
      updatedAt: new Date().toISOString(),
      _weaverMutationToken: freshMutationToken(),
    };
    const storedDocument: Document = { ...document };
    await options.collection.insertOne(storedDocument, {
      maxTimeMS: options.timeoutMs,
    });
    return document;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

function rootDocumentId(options: RootMutationOptions): string {
  const identity = JSON.stringify([
    options.layer,
    options.environment,
    canonicalMongoPath(options.rootKey),
  ]);
  const digest = createHash("sha256").update(identity).digest("hex");
  return `weaver-root:${digest}`;
}

function isDuplicateKeyError(error: unknown): boolean {
  return z.object({ code: z.literal(11000) }).safeParse(error).success;
}

function authoritativeExactRoot(
  options: RootMutationOptions,
  documents: readonly ObservedMongoDocument[],
): ObservedMongoDocument | undefined {
  return sortConfigDocuments(
    documents.filter((document) => document.key === options.rootKey),
  ).at(-1);
}

function freshMutationToken(): string {
  return randomUUID();
}

function hydrateEntries(
  docs: readonly ConfigDocument[],
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

function sortConfigDocuments<T extends ConfigDocument>(
  docs: readonly T[],
): T[] {
  return [...docs].sort((left, right) => {
    const dateOrder = comparableDate(left).localeCompare(comparableDate(right));
    if (dateOrder !== 0) return dateOrder;
    return parsePath(left.key).length - parsePath(right.key).length;
  });
}

export function selectEffectiveDocuments<T extends ConfigDocument>(
  docs: readonly T[],
): T[] {
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

interface ConfigDocument {
  readonly key: string;
  readonly value?: unknown;
  readonly updatedAt?: unknown;
}

function comparableDate(document: ConfigDocument): string {
  return typeof document.updatedAt === "string" ? document.updatedAt : "";
}
