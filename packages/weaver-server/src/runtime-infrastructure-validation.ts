import {
  createWeaverError,
  type InternalInfrastructureGeneration,
  internalIdSchema,
} from "@weaver-conf/config-types";
import { sameConfiguration } from "./bootstrap/manifest";

export function assertGenerationId(id: string): void {
  if (!internalIdSchema.safeParse(id).success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid generation identity");
}

export function assertSameInfrastructureBindings(
  current: InternalInfrastructureGeneration,
  candidate: InternalInfrastructureGeneration,
): void {
  const bindings = (generation: InternalInfrastructureGeneration) =>
    generation.layout.layers
      .map((layer) => [layer.providerId, layer.name, layer.type])
      .sort();
  if (
    !sameConfiguration(current.providers, candidate.providers) ||
    !sameConfiguration(bindings(current), bindings(candidate)) ||
    !sameConfiguration(current.layout.scopes, candidate.layout.scopes)
  )
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "This runtime stages settings/order changes only; new stores or scope definitions require explicit new-target bootstrap",
    );
}
