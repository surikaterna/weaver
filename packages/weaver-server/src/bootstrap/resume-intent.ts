import {
  type BootstrapSeed,
  createWeaverError,
  type InitializeWeaverRequest,
  type InternalConfiguration,
  internalRegistrationId,
} from "@weaver-conf/config-types";
import { initialRegistrationRecord } from "./initial-registrations";
import { initialConfiguration, sameConfiguration } from "./manifest";
import { bootstrapDigest } from "./seed-trust";

/** Resume only the exact recorded initialization, never adopt populated or unrelated state. */
export function assertMatchingInitialization(
  state: InternalConfiguration,
  seed: BootstrapSeed,
  input: InitializeWeaverRequest,
): void {
  const intent = state.format.initializationIntent;
  if (
    state.format.initialization !== "initializing" ||
    !intent ||
    intent.seedDigest !== bootstrapDigest(seed) ||
    intent.inputDigest !== bootstrapDigest(input) ||
    intent.generationId !== input.generationId
  )
    throw createWeaverError(
      "CONFIG_NOT_READY",
      "Existing target is not this recorded incomplete initialization",
    );
  const draft = initialConfiguration(seed, input, {
    storeId: state.format.storeId,
    environment: seed.environment,
  });
  if (!sameConfiguration(state.upgrades, draft.upgrades))
    throw createWeaverError(
      "MAINTENANCE",
      "Upgrade recovery must not be resumed as initialization",
    );
  if (
    !sameConfiguration(state.scopeInventory, draft.scopeInventory) &&
    !sameConfiguration(state.scopeInventory, input.scopeInventory)
  )
    throw createWeaverError(
      "CONFIG_NOT_READY",
      "Initialization inventory has changed",
    );
  assertGenerations(state, draft, input);
  assertRegistrations(state, input);
}

function assertGenerations(
  state: InternalConfiguration,
  draft: InternalConfiguration,
  input: InitializeWeaverRequest,
): void {
  for (const [id, generation] of Object.entries(
    state.infrastructure.generations,
  )) {
    const expected =
      id === "bootstrap"
        ? draft.infrastructure.generations.bootstrap
        : id === input.generationId
          ? input.generation
          : undefined;
    if (!expected || !sameConfiguration(expected, generation))
      throw createWeaverError(
        "CONFIG_NOT_READY",
        "Initialization generation has changed",
      );
  }
}
function assertRegistrations(
  state: InternalConfiguration,
  input: InitializeWeaverRequest,
): void {
  const expected = new Map(
    input.registrations.map((request) => {
      const record = initialRegistrationRecord(request);
      return [internalRegistrationId(record), record];
    }),
  );
  for (const [id, record] of Object.entries(state.catalog.registrations))
    if (!expected.has(id) || !sameConfiguration(record, expected.get(id)))
      throw createWeaverError(
        "CONFIG_NOT_READY",
        "Initialization catalog has changed",
      );
}
