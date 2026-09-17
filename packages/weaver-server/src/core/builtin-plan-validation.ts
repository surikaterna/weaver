import { deepEqual } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type InternalConfiguration,
  type InternalProviderDefinition,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  type ProviderRevision,
} from "@weaver-conf/config-types";

export interface TrustedProviderAuthority {
  readonly providerId: string;
  readonly definition: InternalProviderDefinition;
  readonly namespace: string;
  readonly revisions: readonly ProviderRevision[];
}

/** Historical plans bind their retained source generation, never implicitly the active generation. */
export function validateBuiltinPlanBindings(
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
  authorities: readonly TrustedProviderAuthority[],
): void {
  const generationId = plan.source.infrastructureGeneration;
  if (!Object.hasOwn(state.infrastructure.generations, generationId))
    fail("Upgrade source infrastructure generation is not retained");
  const generation = state.infrastructure.generations[generationId];
  if (!generation) fail("Upgrade source generation is missing");
  const declared = new Set(generation.providers.map((provider) => provider.id));
  const trusted = indexTrustedAuthorities(authorities);
  validateGenerationAuthorities(generation.providers, trusted);
  const revisions = validateInventory(
    plan,
    state.format.environment,
    declared,
    trusted,
  );
  validateFinalLayers(plan, revisions, trusted);
  for (const digest of plan.source.dataDigests) {
    const revision = revisions.get(key(digest.providerId, digest.layer));
    const authority = trusted.get(digest.providerId);
    if (
      !revision ||
      !authority ||
      revision.storeId !== digest.storeId ||
      authority.namespace !== digest.namespace
    )
      fail("Data digest does not bind the source provider inventory");
  }
  const digestIds = plan.source.dataDigests.map((digest) =>
    key(digest.providerId, digest.layer),
  );
  if (new Set(digestIds).size !== digestIds.length)
    fail("Duplicate source data digest identity");
  for (const step of plan.steps) {
    const revision = revisions.get(
      key(step.target.providerId, step.target.layer),
    );
    if (
      !revision ||
      !deepEqual(revision, step.expectedRevision) ||
      revision.storeId !== step.target.storeId
    )
      fail(
        "Upgrade step does not bind the catalog environment/provider inventory",
      );
  }
  for (const record of Object.values(plan.target.registrations ?? {})) {
    if (record.request.environment !== state.format.environment)
      fail("Upgrade registration crosses catalog environments");
  }
}

function validateGenerationAuthorities(
  definitions: readonly InternalProviderDefinition[],
  authorities: ReadonlyMap<string, TrustedProviderAuthority>,
): void {
  for (const definition of definitions) {
    const authority = authorities.get(definition.id);
    if (!authority || !deepEqual(authority.definition, definition))
      fail("Retained provider definition has no matching admitted authority");
  }
}

function validateFinalLayers(
  plan: InternalUpgradePlan,
  revisions: ReadonlyMap<string, ProviderRevision>,
  authorities: ReadonlyMap<string, TrustedProviderAuthority>,
): void {
  const seen = new Set<string>();
  for (const binding of plan.finalLayers) {
    const id = key(binding.providerId, binding.layer);
    const revision = revisions.get(id);
    const source = plan.source.dataDigests.find(
      (item) => key(item.providerId, item.layer) === id,
    );
    const authority = authorities.get(binding.providerId);
    if (
      seen.has(id) ||
      !revision ||
      !source ||
      !authority ||
      binding.storeId !== revision.storeId ||
      binding.environment !== revision.environment ||
      binding.namespace !== authority.namespace ||
      source.namespace !== authority.namespace ||
      binding.contentDomain !== source.contentDomain ||
      binding.sourceDigest !== source.digest
    )
      fail("Final layer binding does not match source authority");
    seen.add(id);
  }
  if (seen.size !== revisions.size)
    fail("Final layer bindings do not completely cover source authority");
}

function validateInventory(
  plan: InternalUpgradePlan,
  environment: string,
  declared: ReadonlySet<string>,
  authorities: ReadonlyMap<string, TrustedProviderAuthority>,
): ReadonlyMap<string, ProviderRevision> {
  const result = new Map<string, ProviderRevision>();
  const providers = new Set<string>();
  const physical = new Set<string>();
  for (const source of plan.source.providerRevisions) {
    if (
      providers.has(source.providerId) ||
      !declared.has(source.providerId) ||
      !authorities.has(source.providerId) ||
      !source.revisions.length
    )
      fail("Invalid or duplicate source provider identity");
    providers.add(source.providerId);
    const stores = new Set(
      source.revisions.map((revision) => revision.storeId),
    );
    if (stores.size !== 1)
      fail("One provider cannot bind contradictory source stores");
    for (const revision of source.revisions) {
      assertTrustedRevision(authorities.get(source.providerId), revision);
      addRevision(result, physical, source.providerId, revision, environment);
    }
  }
  return result;
}

function indexTrustedAuthorities(
  authorities: readonly TrustedProviderAuthority[],
): ReadonlyMap<string, TrustedProviderAuthority> {
  const result = new Map<string, TrustedProviderAuthority>();
  for (const authority of authorities) {
    if (result.has(authority.providerId))
      fail("Duplicate trusted provider authority identity");
    result.set(authority.providerId, authority);
  }
  return result;
}

function assertTrustedRevision(
  authority: TrustedProviderAuthority | undefined,
  revision: ProviderRevision,
): void {
  if (
    !authority?.revisions.some(
      (expected) =>
        expected.storeId === revision.storeId &&
        expected.environment === revision.environment &&
        expected.layer === revision.layer,
    )
  )
    fail("Source revision does not match admitted provider authority identity");
}

function addRevision(
  revisions: Map<string, ProviderRevision>,
  physical: Set<string>,
  providerId: string,
  revision: ProviderRevision,
  environment: string,
): void {
  const id = key(providerId, revision.layer);
  const location = JSON.stringify([
    revision.storeId,
    revision.layer,
    revision.environment,
  ]);
  if (
    revision.environment !== environment ||
    revisions.has(id) ||
    physical.has(location)
  )
    fail("Contradictory source inventory revision/environment");
  revisions.set(id, revision);
  physical.add(location);
}

export function validateJournalPlanBinding(
  state: InternalConfiguration,
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
): void {
  if (journal.infrastructureGeneration !== plan.source.infrastructureGeneration)
    fail("Journal source generation does not match its plan");
  const known = new Map(
    plan.source.providerRevisions.flatMap((source) =>
      source.revisions.map(
        (revision) =>
          [key(source.providerId, revision.layer), revision] as const,
      ),
    ),
  );
  validateJournalSteps(plan, journal, known);
  validateJournalSources(state, journal, known);
}

function validateJournalSteps(
  plan: InternalUpgradePlan,
  journal: InternalRecoveryEnvelope,
  known: ReadonlyMap<string, ProviderRevision>,
): void {
  if (journal.steps.length !== plan.steps.length)
    fail("Journal step set does not match its plan");
  for (const [index, step] of journal.steps.entries()) {
    const planned = plan.steps[index];
    if (
      !planned ||
      planned.id !== step.id ||
      !deepEqual(planned.target, step.target) ||
      !deepEqual(planned.mutation, step.mutation) ||
      planned.preDigest !== step.preDigest ||
      planned.postDigest !== step.postDigest ||
      !deepEqual(planned.undo, step.undo)
    )
      fail("Journal step content does not match its plan");
    const source = known.get(key(step.target.providerId, step.target.layer));
    if (
      !source ||
      !sameIdentity(source, step.preRevision) ||
      BigInt(step.preRevision.sequence) < BigInt(source.sequence)
    )
      fail("Journal step does not bind the source plan authority");
  }
}

function validateJournalSources(
  state: InternalConfiguration,
  journal: InternalRecoveryEnvelope,
  known: ReadonlyMap<string, ProviderRevision>,
): void {
  for (const source of journal.sourceRevisions ?? []) {
    if (
      !deepEqual(
        known.get(key(source.providerId, source.revision.layer)),
        source.revision,
      )
    )
      fail("Journal inventory does not match plan source");
  }
  if (
    journal.control &&
    (journal.control.revision.storeId !== state.format.storeId ||
      journal.control.revision.environment !== state.format.environment ||
      !deepEqual(
        known.get(
          key(journal.control.providerId, journal.control.revision.layer),
        ),
        journal.control.revision,
      ))
  )
    fail("Journal control authority does not match control-layer binding");
  for (const entry of "cursor" in journal ? (journal.cursor ?? []) : []) {
    if (entry.revision.environment !== state.format.environment)
      fail("Journal cursor crosses catalog environments");
  }
}

function sameIdentity(
  left: ProviderRevision,
  right: ProviderRevision,
): boolean {
  return deepEqual({ ...left, sequence: right.sequence }, right);
}

function key(providerId: string, layer: string): string {
  return JSON.stringify([providerId, layer]);
}

function fail(message: string): never {
  throw createWeaverError("VALIDATION_ERROR", message);
}
