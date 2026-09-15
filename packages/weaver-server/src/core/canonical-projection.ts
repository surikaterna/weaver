import {
  createWeaverError,
  type InternalCatalog,
  internalCatalogSchema,
} from "@weaver-conf/config-types";
import type { RegisteredSchemaAnchor } from "./schema-registry";
import { composeRegistryEntries } from "./schema-registry-composition";
import {
  applyEvaluation,
  createEmptyState,
  evaluateRegistration,
} from "./schema-registry-state";

/** Maps contain only a rebuildable projection of committed canonical records. */
export function projectCanonicalRegistrations(input: InternalCatalog) {
  const catalog = internalCatalogSchema.parse(input);
  const state = createEmptyState();
  const records = Object.values(catalog.registrations).sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "service" ? -1 : 1,
  );
  for (const record of records) {
    const evaluation = evaluateRegistration(
      state,
      record.request,
      record.audit,
    );
    if (!evaluation.result.success)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Invalid canonical registry",
        {
          error: evaluation.result.error,
        },
      );
    applyEvaluation(state, evaluation);
  }
  const anchors: RegisteredSchemaAnchor[] = [
    ...composeRegistryEntries(state),
  ].map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    schema: entry.schema,
    environment: entry.environment,
    metadata: entry.metadata,
  }));
  return { state, anchors };
}
