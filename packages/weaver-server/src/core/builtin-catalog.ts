import { createHash } from "node:crypto";
import {
  compileBuiltinContract,
  compileInternalLayout,
  compileInternalRegistrations,
} from "@weaver-conf/config-engine";
import {
  BUILTIN_CATALOG_REFERENCE,
  builtinCatalogManifest,
  canonicalInternalJson,
  createWeaverError,
  freezeBuiltinData,
  getBuiltinCatalogSource,
  INTERNAL_RECOVERY_MAX_BYTES,
  type InternalCatalogBinding,
  type InternalConfiguration,
  SUPPORTED_SOURCE_BUILTIN_CATALOGS,
} from "@weaver-conf/config-types";
import {
  type TrustedProviderAuthority,
  validateBuiltinPlanBindings,
  validateJournalPlanBinding,
} from "./builtin-plan-validation";
import { validateBuiltinRecoveryEvidence } from "./builtin-recovery-validation";

const source = getBuiltinCatalogSource();
const validateConfiguration = compileBuiltinContract(
  source.contracts.configuration,
);
const validateRecovery = compileBuiltinContract(source.contracts.recovery);
const validateBinding = compileBuiltinContract(source.contracts.binding);

/** Code-pinned identity. A stored reference never selects or replaces executable validators. */
export function builtinCatalogReference() {
  const digest = createHash("sha256")
    .update(canonicalInternalJson(builtinCatalogManifest()))
    .digest("hex");
  if (digest !== BUILTIN_CATALOG_REFERENCE.digest)
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Built-in code catalog digest does not match its pin",
    );
  return BUILTIN_CATALOG_REFERENCE;
}

export function assertSupportedSourceBuiltinCatalog(reference: unknown): void {
  if (
    !SUPPORTED_SOURCE_BUILTIN_CATALOGS.some(
      (supported) =>
        canonicalInternalJson(supported) === canonicalInternalJson(reference),
    )
  )
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Upgrade source built-in catalog is not supported by this binary",
    );
}

/** Future pipeline entry: validate control data BEFORE activating the application registry. No provider or registry is accepted. */
export function prepareBuiltinCatalog(
  raw: unknown,
  expected: InternalCatalogBinding,
  authorities: readonly TrustedProviderAuthority[] = [],
) {
  return prepareCatalog(raw, expected, true, authorities);
}

/** Explicit control admission may stage validated metadata, never application readiness. */
export function prepareControlCatalog(
  raw: unknown,
  expected: InternalCatalogBinding,
) {
  return prepareCatalog(raw, expected, false, []);
}

function prepareCatalog(
  raw: unknown,
  expected: InternalCatalogBinding,
  initialized: boolean,
  authorities: readonly TrustedProviderAuthority[],
) {
  const binding = validateBinding(expected);
  const reference = builtinCatalogReference();
  const state = validateConfiguration(raw);
  assertBinding(state, binding, reference, initialized);
  validatePlans(state, initialized ? authorities : undefined);
  const applicationSchemas = compileInternalRegistrations(state.catalog);
  const generation =
    state.infrastructure.generations[state.infrastructure.activeGeneration];
  if (!generation)
    throw createWeaverError("SERVER_DEGRADED", "Active generation missing");
  const layout = compileInternalLayout(generation.layout);
  return Object.freeze({
    configuration: freezeBuiltinData(state),
    applicationSchemas,
    layout,
  });
}

/** Reads only the pinned recovery envelope; invalid/missing target catalog data is not consulted. */
export function readBuiltinRecoveryEnvelope(raw: unknown) {
  if (
    new TextEncoder().encode(canonicalInternalJson(raw)).byteLength >
    INTERNAL_RECOVERY_MAX_BYTES
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Recovery envelope exceeds code-pinned size bound",
    );
  const journal = validateRecovery(raw);
  validateBuiltinRecoveryEvidence(journal);
  return freezeBuiltinData(journal);
}

function assertBinding(
  state: InternalConfiguration,
  binding: InternalCatalogBinding,
  reference: typeof BUILTIN_CATALOG_REFERENCE,
  initialized: boolean,
): void {
  if (
    state.format.storeId !== binding.storeId ||
    state.format.environment !== binding.environment
  )
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Control-layer store/environment identity mismatch",
    );
  if (
    canonicalInternalJson(state.format.builtinCatalog) !==
    canonicalInternalJson(reference)
  )
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Stored built-in catalog identity/version/digest does not match code",
    );
  if (initialized && state.format.initialization !== "initialized")
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Internal catalog is not initialized",
    );
}

function validatePlans(
  state: InternalConfiguration,
  authorities?: readonly TrustedProviderAuthority[],
): void {
  for (const plan of Object.values(state.upgrades.plans)) {
    const { id, ...body } = plan;
    const digest = createHash("sha256")
      .update(canonicalInternalJson(body))
      .digest("hex");
    if (digest !== id)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Upgrade plan body digest mismatch",
      );
    if (plan.target.registrations)
      compileInternalRegistrations({
        registrations: plan.target.registrations,
      });
    if (authorities) validateBuiltinPlanBindings(state, plan, authorities);
  }
  for (const journal of Object.values(state.upgrades.journal)) {
    if (!Object.hasOwn(state.upgrades.plans, journal.planId))
      throw createWeaverError(
        "SERVER_DEGRADED",
        "Journal references a missing plan; use pinned recovery",
      );
    const plan = state.upgrades.plans[journal.planId];
    if (!plan)
      throw createWeaverError("VALIDATION_ERROR", "Journal plan is missing");
    validateBuiltinRecoveryEvidence(journal);
    validateJournalPlanBinding(state, plan, journal);
  }
}
