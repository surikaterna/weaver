import type { Collection, Document, Filter } from "mongodb";
import type { ObservedMongoDocument } from "./mongodb-root-snapshot.js";

interface DeleteObservedMongoDocumentsOptions {
  readonly collection: Collection;
  readonly documents: readonly ObservedMongoDocument[];
  readonly timeoutMs: number;
}

export async function deleteObservedMongoDocuments(
  options: DeleteObservedMongoDocumentsOptions,
): Promise<void> {
  for (const document of options.documents) {
    await options.collection.deleteOne(observedMongoDocumentFilter(document), {
      maxTimeMS: options.timeoutMs,
    });
  }
}

export function observedMongoDocumentFilter(
  document: ObservedMongoDocument,
): Filter<Document> {
  return {
    layer: document.layer,
    environment: document.environment,
    key: document.key,
    ...observedOptionalField(document, "_id"),
    ...observedOptionalField(document, "updatedAt"),
    ...observedOptionalField(document, "_weaverMutationToken"),
    ...observedOptionalField(document, "_weaverMutationVersion"),
    ...observedOptionalField(document, "value"),
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
