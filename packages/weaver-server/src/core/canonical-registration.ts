import { deepEqual, deriveFragmentPath } from "@weaver-conf/config-engine";
import {
  internalCatalogSchema,
  internalRegistrationId,
  internalRegistrationRecordSchema,
} from "@weaver-conf/config-types";
import type { z } from "zod";
import { projectCanonicalRegistrations } from "./canonical-projection";
import { schemaCompatibility } from "./schema-activation";
import type {
  SchemaRegistrationContext,
  SchemaRegistrationRequest,
  SchemaRegistrationResult,
} from "./schema-registry";
import { evaluateRegistration, schemaKey } from "./schema-registry-state";

type Record = z.infer<typeof internalRegistrationRecordSchema>;

export function prepareCanonicalRegistration(
  registrations: unknown,
  request: SchemaRegistrationRequest,
  context?: SchemaRegistrationContext,
) {
  const record = internalRegistrationRecordSchema.parse({
    version: 1,
    kind: "providerId" in request ? "fragment" : "service",
    request,
    audit: {
      actor: context?.actor ?? context?.subject ?? "system",
      ...(context?.subject ? { subject: context.subject } : {}),
    },
  });
  const id = internalRegistrationId(record);
  const catalog = internalCatalogSchema.parse({ registrations });
  const existing = catalog.registrations[id];
  const changed = existing && !deepEqual(existing.request, record.request);
  const state = projectCanonicalRegistrations(catalog).state;
  if (changed && record.kind === "fragment") {
    const derived = deriveFragmentPath(
      record.request.serviceId,
      record.request.slotPath,
      record.request.providerId,
    );
    state.schemas.delete(
      schemaKey(derived.fragmentPath, record.request.environment),
    );
  }
  return {
    record,
    id,
    existing,
    changed,
    evaluation: evaluateRegistration(state, record.request, context),
    compatibility: registrationCompatibility(existing, record),
  };
}

function registrationCompatibility(
  existing: Record | undefined,
  record: Record,
): Pick<
  SchemaRegistrationResult,
  "compatibility" | "hasBreakingChanges" | "breakingChanges"
> {
  if (!existing)
    return { compatibility: "compatible", hasBreakingChanges: false };
  if (
    existing.kind === "service" &&
    record.kind === "service" &&
    !deepEqual(existing.request.fragmentSlots, record.request.fragmentSlots)
  )
    return { compatibility: "unknown", hasBreakingChanges: true };
  return schemaCompatibility(existing.request.schema, record.request.schema);
}
