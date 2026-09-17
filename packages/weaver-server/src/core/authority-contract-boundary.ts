import { deepEqual, deepRemove, deepSet } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type LayerCommitRequest,
  type LayerCommitResult,
  type LayerEnvelope,
  layerCommitResultSchema,
  type ProviderCapabilities,
  type ProviderRevision,
} from "@weaver-conf/config-types";
import {
  computeProviderMutationDigest,
  getProviderRevision,
  validateProviderEnvelope,
} from "@weaver-conf/storage-providers";

export function validateAuthorityRead(
  raw: unknown,
  layer: string,
  expected?: ProviderRevision,
  exact = false,
): LayerEnvelope {
  const snapshot = validateProviderEnvelope(raw);
  const revision = getProviderRevision(snapshot);
  if (
    snapshot.layer !== layer ||
    (expected &&
      !deepEqual(
        exact ? revision : { ...revision, sequence: expected.sequence },
        expected,
      ))
  )
    throw createWeaverError(
      "PROVIDER_CORRUPT",
      "Provider snapshot does not match captured authority identity/revision",
    );
  const receipt = snapshot.lastCommit;
  if (receipt) {
    const increment =
      BigInt(snapshot.sequence) - BigInt(receipt.previousRevision.sequence);
    if (
      !deepEqual(
        { ...receipt.previousRevision, sequence: snapshot.sequence },
        revision,
      ) ||
      increment < 0n ||
      increment > 1n
    )
      throw createWeaverError(
        "PROVIDER_CORRUPT",
        "Provider receipt has an invalid previous revision",
      );
  }
  return snapshot;
}

/** After IO, contract violations mean possible effects, never a claimed no-effect failure. */
export function validateAuthorityCommit(
  raw: unknown,
  current: LayerEnvelope,
  request: LayerCommitRequest,
  capabilities: ProviderCapabilities,
): LayerCommitResult {
  try {
    if (raw !== null && typeof raw === "object" && "snapshot" in raw)
      validateProviderEnvelope(raw.snapshot);
    const result = layerCommitResultSchema.parse(raw);
    if (!result.success) return result;
    const snapshot = validateAuthorityRead(
      result.snapshot,
      request.layer,
      request.expectedRevision,
    );
    const acknowledgement =
      capabilities.kind === "durable-exclusive" ? "durable" : "volatile";
    const entries: Record<string, unknown> = structuredClone(current.entries);
    if (request.mutation.action === "remove")
      deepRemove(entries, request.mutation.key);
    else deepSet(entries, request.mutation.key, request.mutation.value);
    const sequence = deepEqual(entries, current.entries)
      ? current.sequence
      : (BigInt(current.sequence) + 1n).toString();
    const receipt = snapshot.lastCommit;
    if (
      result.acknowledgement !== acknowledgement ||
      snapshot.sequence !== sequence ||
      !deepEqual(snapshot.entries, entries) ||
      !receipt ||
      receipt.operationId !== request.operationId ||
      !deepEqual(receipt.previousRevision, request.expectedRevision) ||
      receipt.mutationDigest !== computeProviderMutationDigest(request)
    )
      throw createWeaverError(
        "COMMIT_OUTCOME_UNKNOWN",
        "Invalid provider commit acknowledgement/receipt/content",
      );
    return result;
  } catch (error) {
    throw createWeaverError(
      "COMMIT_OUTCOME_UNKNOWN",
      "Provider commit response violates authority contract",
      { cause: String(error) },
    );
  }
}
