import { randomBytes } from "node:crypto";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalUpgradePlan,
  type ScopeInstance,
  sha256Hex,
  type ValidatedFinalContextsBinding,
  validatedFinalContextsBindingSchema,
  validatedFinalContextsDigest,
} from "@weaver-conf/config-types";
import type { CandidateLayers } from "./config-candidates";
import type { ValidatedCandidate } from "./config-pipeline";
import { scopeContextId } from "./scope-inventory";

export interface EphemeralFinalContext {
  readonly id: string;
  readonly scopePath: readonly ScopeInstance[];
  readonly authorityVector: readonly string[];
  readonly prepared: Readonly<Record<string, unknown>>;
  readonly delivered: Readonly<Record<string, unknown>>;
}

export interface ValidatedFinalContexts {
  readonly binding: ValidatedFinalContextsBinding;
  readonly contexts: readonly EphemeralFinalContext[];
  readonly base: readonly EphemeralLayer[];
  readonly scoped: readonly EphemeralLayer[];
}

interface EphemeralLayer {
  readonly id: string;
  readonly entries: Readonly<Record<string, unknown>>;
}

const constructedSnapshots = new WeakSet<ValidatedFinalContexts>();

export function buildValidatedFinalContexts(
  plan: InternalUpgradePlan,
  candidate: ValidatedCandidate,
  layers: ValidatedFinalContextsBinding["layers"],
  runId: string,
  source?: CandidateLayers,
): ValidatedFinalContexts {
  return buildEvidence(
    plan,
    candidate,
    layers,
    runId,
    randomBytes(32).toString("hex"),
    source,
  );
}

export function buildValidatedFinalContextsForTest(
  plan: InternalUpgradePlan,
  candidate: ValidatedCandidate,
  layers: ValidatedFinalContextsBinding["layers"],
  runId: string,
  nonce: string,
  source?: CandidateLayers,
): ValidatedFinalContexts {
  return buildEvidence(plan, candidate, layers, runId, nonce, source);
}

export function reconstructValidatedFinalContexts(
  plan: InternalUpgradePlan,
  candidate: ValidatedCandidate,
  layers: ValidatedFinalContextsBinding["layers"],
  runId: string,
  nonce: string,
  source: CandidateLayers,
): ValidatedFinalContexts {
  return buildEvidence(plan, candidate, layers, runId, nonce, source);
}

function buildEvidence(
  plan: InternalUpgradePlan,
  candidate: ValidatedCandidate,
  layers: ValidatedFinalContextsBinding["layers"],
  runId: string,
  nonce: string,
  source?: CandidateLayers,
): ValidatedFinalContexts {
  assertExactContexts(plan.contexts, candidate.contexts);
  const authorityVector = layers.map((layer) => layerCommitment(runId, layer));
  const ephemeral = candidate.contexts.map(({ scopePath, entries }) => {
    const delivered = frozenClone(entries);
    return frozenClone({
      id: scopeContextId(scopePath),
      scopePath,
      authorityVector,
      prepared: delivered,
      delivered,
    });
  });
  const contexts = ephemeral.map((context) => ({
    id: context.id,
    scopePath: context.scopePath,
    authorityVector: context.authorityVector,
    deliveredDigest: deliveredDigest(runId, nonce, context),
  }));
  const unsigned = {
    version: 1 as const,
    runId,
    nonce,
    planId: plan.id,
    targetCatalogDigest: plan.target.catalogDigest,
    layers: frozenClone(layers),
    contexts,
  };
  const binding = validatedFinalContextsBindingSchema.parse({
    ...unsigned,
    aggregateDigest: validatedFinalContextsDigest(unsigned),
  });
  const snapshot = {
    binding: frozenClone(binding),
    contexts: ephemeral,
    base: frozenClone(mapLayers(source?.base)),
    scoped: frozenClone(mapLayers(source?.scoped)),
  };
  Object.freeze(snapshot);
  constructedSnapshots.add(snapshot);
  return snapshot;
}

export function assertConstructedFinalContexts(
  snapshot: ValidatedFinalContexts,
): void {
  if (!constructedSnapshots.has(snapshot))
    throw createWeaverError(
      "FORBIDDEN",
      "Application admission requires internally validated contexts",
    );
}

function mapLayers(
  source: ReadonlyMap<string, Record<string, unknown>> | undefined,
): readonly EphemeralLayer[] {
  return [...(source ?? [])]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, entries]) => ({ id, entries }));
}

export function finalContextsMatchPlan(
  binding: ValidatedFinalContextsBinding,
  plan: InternalUpgradePlan,
  runId: string,
): boolean {
  const parsed = validatedFinalContextsBindingSchema.safeParse(binding);
  return (
    parsed.success &&
    parsed.data.runId === runId &&
    parsed.data.planId === plan.id &&
    parsed.data.targetCatalogDigest === plan.target.catalogDigest &&
    canonicalInternalJson(
      parsed.data.contexts.map((item) => item.scopePath),
    ) === canonicalInternalJson(plan.contexts)
  );
}

function deliveredDigest(
  runId: string,
  nonce: string,
  context: Pick<
    EphemeralFinalContext,
    "id" | "scopePath" | "authorityVector" | "prepared" | "delivered"
  >,
): string {
  // A nonce prevents cross-run correlation; it cannot conceal guessable low-entropy configuration.
  return sha256Hex(
    canonicalInternalJson({
      domain: "weaver.final-context-delivered.v2",
      runId,
      nonce,
      context,
    }),
  );
}

function layerCommitment(
  runId: string,
  layer: ValidatedFinalContextsBinding["layers"][number],
): string {
  return sha256Hex(
    canonicalInternalJson({
      domain: "weaver.final-context-layer.v2",
      runId,
      layer,
    }),
  );
}

function assertExactContexts(
  expected: readonly (readonly ScopeInstance[])[],
  actual: ValidatedCandidate["contexts"],
): void {
  const expectedIds = expected.map(scopeContextId);
  const actualIds = actual.map((context) => scopeContextId(context.scopePath));
  if (
    new Set(actualIds).size !== actualIds.length ||
    canonicalInternalJson(expectedIds) !== canonicalInternalJson(actualIds)
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Validated final context set differs from the bound plan",
    );
}

function frozenClone<T>(value: T): T {
  const clone = structuredClone(value);
  deepFreeze(clone);
  return clone;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value))
    return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}
