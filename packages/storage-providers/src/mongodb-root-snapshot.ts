import { parsePath } from "@weaver-conf/config-engine";
import type { Collection, Document } from "mongodb";
import { z } from "zod";
import {
  isSameMongoPathOrDescendant,
  mongoPathCandidatePattern,
} from "./mongodb-path-identity.js";

export const MAX_MONGO_ROOT_CANDIDATES = 256;

const mongoDocumentIdSchema = z.custom<unknown>(
  (value) => value !== undefined,
  "MongoDB document identity is required",
);

export const storedConfigDocumentSchema = z.object({
  _id: z.unknown().optional(),
  layer: z.string(),
  environment: z.string(),
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.string(),
  _weaverMutationVersion: z.unknown().optional(),
  _weaverMutationToken: z.unknown().optional(),
});

export type StoredConfigDocument = z.infer<typeof storedConfigDocumentSchema>;

const rootCandidateSchema = z.object({
  _id: mongoDocumentIdSchema,
});

export const observedMongoDocumentSchema = z.object({
  _id: mongoDocumentIdSchema,
  layer: z.string(),
  environment: z.string(),
  key: z.string(),
  value: z.unknown().optional(),
  updatedAt: z.unknown().optional(),
  _weaverMutationVersion: z.unknown().optional(),
  _weaverMutationToken: z.unknown().optional(),
});

export type ObservedMongoDocument = z.infer<typeof observedMongoDocumentSchema>;

export interface MongoRootSnapshot {
  readonly documents: readonly ObservedMongoDocument[];
}

interface MongoRootSnapshotOptions {
  readonly collection: Collection;
  readonly layer: string;
  readonly environment: string;
  readonly rootKey: string;
  readonly timeoutMs: number;
}

export class MongoRootCandidateLimitError extends Error {
  constructor(rootKey: string) {
    super(
      `MongoDB root "${rootKey}" exceeds the ${MAX_MONGO_ROOT_CANDIDATES} candidate limit`,
    );
    this.name = "MongoRootCandidateLimitError";
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

export async function snapshotMongoRoot(
  options: MongoRootSnapshotOptions,
): Promise<MongoRootSnapshot> {
  const candidates = await discoverRootCandidates(options);
  if (candidates.length > MAX_MONGO_ROOT_CANDIDATES) {
    throw new MongoRootCandidateLimitError(options.rootKey);
  }
  if (candidates.length === 0) {
    return { documents: [] };
  }
  const exactFilter: Document = {
    layer: options.layer,
    environment: options.environment,
    _id: { $in: candidates.map((candidate) => candidate._id) },
  };
  const rawDocuments = await options.collection
    .find(exactFilter, { projection: observedProjection() })
    .maxTimeMS(options.timeoutMs)
    .limit(MAX_MONGO_ROOT_CANDIDATES)
    .toArray();
  const documents = z.array(observedMongoDocumentSchema).parse(rawDocuments);
  const target = parsePath(options.rootKey);
  return {
    documents: documents.filter((document) =>
      isSameMongoPathOrDescendant(parsePath(document.key), target),
    ),
  };
}

async function discoverRootCandidates(options: MongoRootSnapshotOptions) {
  const rawCandidates = await options.collection
    .find(
      {
        layer: options.layer,
        environment: options.environment,
        key: { $regex: mongoPathCandidatePattern(options.rootKey) },
      },
      { projection: candidateProjection() },
    )
    .maxTimeMS(options.timeoutMs)
    .limit(MAX_MONGO_ROOT_CANDIDATES + 1)
    .toArray();
  return z.array(rootCandidateSchema).parse(rawCandidates);
}

function candidateProjection(): Record<string, 1> {
  return {
    _id: 1,
  };
}

function observedProjection(): Record<string, 1> {
  return {
    _id: 1,
    layer: 1,
    environment: 1,
    key: 1,
    value: 1,
    updatedAt: 1,
    _weaverMutationToken: 1,
    _weaverMutationVersion: 1,
  };
}
