import {
  type BootstrapSeed,
  canonicalInternalJson,
  createWeaverError,
  type InitializeWeaverRequest,
  type InternalCatalogBinding,
  type InternalConfiguration,
  type InternalRegistrationRecord,
  internalConfigurationSchema,
  internalRegistrationId,
} from "@weaver-conf/config-types";
import {
  builtinCatalogReference,
  prepareControlCatalog,
} from "../core/builtin-catalog";
import { projectCanonicalRegistrations } from "../core/canonical-projection";
import { validateCoveredEffective } from "../core/config-coverage";
import { CONTROL_LAYER, seedProviderDefinition } from "./compile-layout";
import { initialRegistrationRecord } from "./initial-registrations";
import { bootstrapDigest } from "./seed-trust";

export function initialConfiguration(
  seed: BootstrapSeed,
  input: InitializeWeaverRequest,
  binding: InternalCatalogBinding,
): InternalConfiguration {
  return internalConfigurationSchema.parse({
    format: {
      version: 1,
      ...binding,
      initialization: "initializing",
      builtinCatalog: builtinCatalogReference(),
      initializationIntent: {
        seedDigest: bootstrapDigest(seed),
        inputDigest: bootstrapDigest(input),
        generationId: input.generationId,
      },
    },
    catalog: { registrations: {} },
    infrastructure: {
      activeGeneration: "bootstrap",
      generations: {
        bootstrap: {
          version: 1,
          layout: {
            layers: [
              {
                name: CONTROL_LAYER,
                type: "static",
                providerId: CONTROL_LAYER,
                config: { mergeId: "deep" },
              },
            ],
            scopes: [],
          },
          providers: [seedProviderDefinition(seed)],
          server: input.generation.server,
        },
      },
    },
    scopeInventory: { version: 1, revision: "0", contexts: {} },
    upgrades: { plans: {}, journal: {} },
  });
}
export function validateInitializationInput(
  seed: BootstrapSeed,
  input: InitializeWeaverRequest,
): void {
  if (input.generationId === "bootstrap")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "bootstrap is a reserved generation identity",
    );
  if (input.scopeInventory.revision !== "0")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Fresh inventory revision must be zero",
    );
  const catalog = initialRegistrations(seed, input);
  const draft = initialConfiguration(seed, input, {
    storeId: "new-target",
    environment: seed.environment,
  });
  const state = internalConfigurationSchema.parse({
    ...draft,
    catalog,
    infrastructure: {
      activeGeneration: input.generationId,
      generations: { [input.generationId]: input.generation },
    },
    scopeInventory: input.scopeInventory,
  });
  const anchors = projectCanonicalRegistrations(state.catalog).anchors.filter(
    (anchor) => anchor.kind === "service",
  );
  validateCoveredEffective({}, anchors);
}

function initialRegistrations(
  seed: BootstrapSeed,
  input: InitializeWeaverRequest,
) {
  const records: InternalRegistrationRecord[] = input.registrations
    .map(initialRegistrationRecord)
    .map((record) => {
      if (record.request.environment !== seed.environment)
        throw createWeaverError(
          "VALIDATION_ERROR",
          "Registration environment differs from seed",
        );
      return record;
    });
  const catalog = {
    registrations: Object.fromEntries(
      records.map((record) => [internalRegistrationId(record), record]),
    ),
  };
  if (Object.keys(catalog.registrations).length !== records.length)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Duplicate initial registration",
    );
  return catalog;
}
export function parseCurrentControl(
  raw: unknown,
  seed: BootstrapSeed,
  binding: InternalCatalogBinding,
  allowMaintenance: boolean,
) {
  if (raw === undefined)
    throw createWeaverError(
      "CONFIG_NOT_READY",
      "Store is not initialized; explicitly initialize a fresh target",
    );
  const prepared = prepareControlCatalog(raw, binding);
  const state = prepared.configuration;
  const intent = state.format.initializationIntent;
  if (!intent || intent.seedDigest !== bootstrapDigest(seed))
    throw createWeaverError(
      "CONFIG_NOT_READY",
      "Missing or mismatched seed-bound initialization intent; existing stores are not adopted",
    );
  if (state.format.initialization === "uninitialized")
    throw createWeaverError(
      "CONFIG_NOT_READY",
      "An unrecorded draft is not a standalone store",
    );
  if (
    state.format.initialization === "initialized" &&
    (state.infrastructure.activeGeneration === "bootstrap" ||
      !state.infrastructure.generations[intent.generationId])
  )
    throw createWeaverError(
      "CONFIG_NOT_READY",
      "Initialization has no completed target generation",
    );
  const incomplete =
    state.format.initialization !== "initialized" ||
    Object.values(state.upgrades.journal).some(
      (journal) =>
        !["completed", "compensated", "restart-required"].includes(
          journal.phase,
        ),
    );
  if (incomplete && !allowMaintenance)
    throw createWeaverError(
      "MAINTENANCE",
      "Recorded initialization or recovery is incomplete; inspect with local administration",
    );
  return { state, incomplete };
}
export function assertSeedEntries(entries: Record<string, unknown>): void {
  if (Object.keys(entries).some((key) => key !== "_weaver"))
    throw createWeaverError(
      "CONFIG_NOT_READY",
      "Unsupported populated seed namespace; preserve it and use a fresh target",
    );
}
export function sameConfiguration(left: unknown, right: unknown): boolean {
  return canonicalInternalJson(left) === canonicalInternalJson(right);
}
