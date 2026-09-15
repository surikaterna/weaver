import {
  canonicalInternalJson,
  createWeaverError,
  type InitializeWeaverRequest,
  internalRegistrationId,
  internalRegistrationRecordSchema,
} from "@weaver-conf/config-types";
import { controlProjection } from "../core/config-service-internal";
import type { createControlService } from "../core/control-service";
import {
  applyEvaluation,
  createEmptyState,
  evaluateRegistration,
} from "../core/schema-registry-state";

type Registration = InitializeWeaverRequest["registrations"][number];
type Control = Awaited<ReturnType<typeof createControlService>>;

export function initialRegistrationRecord(request: Registration) {
  return internalRegistrationRecordSchema.parse({
    version: 1,
    kind: "providerId" in request ? "fragment" : "service",
    request,
    audit: { actor: "seed-administrator" },
  });
}

/** Services own every slot, including nested paths; independent records have a stable tie-break. */
export function orderInitialRegistrations(
  requests: readonly Registration[],
): Registration[] {
  const ordered = [...requests].sort((left, right) => {
    const dependency =
      Number("providerId" in left) - Number("providerId" in right);
    if (dependency) return dependency;
    const a = internalRegistrationId(initialRegistrationRecord(left));
    const b = internalRegistrationId(initialRegistrationRecord(right));
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const state = createEmptyState();
  for (const request of ordered) {
    const evaluation = evaluateRegistration(state, request);
    if (!evaluation.result.success)
      throw (
        evaluation.result.error ??
        createWeaverError(
          "VALIDATION_ERROR",
          "Initial registration cannot be installed",
        )
      );
    applyEvaluation(state, evaluation);
  }
  return ordered;
}

export async function installInitialRegistrations(
  control: Control,
  requests: readonly Registration[],
): Promise<void> {
  for (const request of requests) {
    const record = initialRegistrationRecord(request);
    const existing = controlProjection(control.configuration).prepared()
      .configuration.catalog.registrations[internalRegistrationId(record)];
    if (existing) {
      if (canonicalInternalJson(existing) !== canonicalInternalJson(record))
        throw createWeaverError(
          "CONFIG_NOT_READY",
          "Initialization registration differs from recorded intent",
        );
      // Exact-intent recovery skips completed records, without changing ordinary fragment replay policy.
      continue;
    }
    const result = await control.registerSchema(request, {
      actor: "seed-administrator",
      expectedRevision: control.revision,
    });
    if (!result.success)
      throw (
        result.error ??
        createWeaverError("VALIDATION_ERROR", "Registration failed")
      );
  }
}
