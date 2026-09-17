import {
  createWeaverError,
  type InternalRecoveryEnvelope,
  internalRecoveryEnvelopeSchema,
  type UpgradeRecoveryRequest,
} from "@weaver-conf/config-types";

export function assertRecoveryAdoptionAuthorized(
  owner: string,
  journal: InternalRecoveryEnvelope,
  request: UpgradeRecoveryRequest,
): void {
  if (journal.owner !== owner && !request.priorOwnerStopped)
    throw createWeaverError(
      "FORBIDDEN",
      "Explicit prior-owner-stopped evidence is required",
    );
}

export function createAdoptionJournal(
  owner: string,
  journal: InternalRecoveryEnvelope,
  request: UpgradeRecoveryRequest,
): InternalRecoveryEnvelope {
  return internalRecoveryEnvelopeSchema.parse({
    ...journal,
    owner,
    adoption: {
      previousOwner: journal.owner,
      adoptedBy: owner,
      priorOwnerStopped: request.priorOwnerStopped,
    },
  });
}

export function lacksSameOwnerFinalContextEvidence(
  journal: InternalRecoveryEnvelope,
  adoptedByRecoveryAuthority: boolean,
): boolean {
  return (
    !adoptedByRecoveryAuthority &&
    journal.steps.some(({ status }) => status === "intent")
  );
}
