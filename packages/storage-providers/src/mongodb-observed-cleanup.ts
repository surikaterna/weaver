import type { Collection, Document, Filter } from "mongodb";
import { z } from "zod";

export const observedMongoDocumentSchema = z.object({
  _id: z.unknown().optional(),
  key: z.string(),
  updatedAt: z.unknown().optional(),
  value: z.unknown().optional(),
  _weaverMutationVersion: z.unknown().optional(),
  _weaverMutationToken: z.unknown().optional(),
});

export type ObservedMongoDocument = z.infer<typeof observedMongoDocumentSchema>;

interface DeleteObservedMongoDocumentsOptions {
  readonly collection: Collection;
  readonly layer: string;
  readonly environment: string;
  readonly documents: readonly ObservedMongoDocument[];
  readonly compareValue: boolean;
  readonly timeoutMs: number;
}

export async function deleteObservedMongoDocuments(
  options: DeleteObservedMongoDocumentsOptions,
): Promise<void> {
  for (const document of options.documents) {
    await options.collection.deleteOne(
      observedDocumentFilter(options, document),
      { maxTimeMS: options.timeoutMs },
    );
  }
}

function observedDocumentFilter(
  options: DeleteObservedMongoDocumentsOptions,
  document: ObservedMongoDocument,
): Filter<Document> {
  return {
    layer: options.layer,
    environment: options.environment,
    key: document.key,
    ...observedOptionalField(document, "_id"),
    ...observedOptionalField(document, "updatedAt"),
    ...observedOptionalField(document, "_weaverMutationToken"),
    ...observedOptionalField(document, "_weaverMutationVersion"),
    ...(options.compareValue ? observedOptionalField(document, "value") : {}),
  };
}

function observedOptionalField(
  document: ObservedMongoDocument,
  field: keyof ObservedMongoDocument,
): Document {
  return Object.hasOwn(document, field)
    ? { [field]: { $eq: document[field] } }
    : { [field]: { $exists: false } };
}
