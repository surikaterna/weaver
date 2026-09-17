import { createHash, randomUUID } from "node:crypto";
import {
  assertSafePathSegment,
  deepEqual,
  deepRemove,
  deepSet,
  normalizeStorageWritePath,
} from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type LayerCommitRequest,
  type LayerEnvelope,
  layerEnvelopeSchema,
  type ProviderRevision,
  providerRevisionSchema,
} from "@weaver-conf/config-types";

export function revisionOf(envelope: LayerEnvelope): ProviderRevision {
  return providerRevisionSchema.parse({
    storeId: envelope.storeId,
    environment: envelope.environment,
    layer: envelope.layer,
    epoch: envelope.epoch,
    sequence: envelope.sequence,
  });
}

export function freshEnvelope(
  storeId: string,
  environment: string,
  layer: string,
  entries: Record<string, unknown> = {},
): LayerEnvelope {
  return parseEnvelope({
    storageFormat: 1,
    storeId,
    environment,
    layer,
    epoch: randomUUID(),
    sequence: "0",
    entries,
  });
}

export function parseEnvelope(value: unknown): LayerEnvelope {
  assertPersistedKeys(value);
  const parsed = layerEnvelopeSchema.safeParse(value);
  if (!parsed.success)
    throw createWeaverError(
      "PROVIDER_CORRUPT",
      "Invalid or unsupported layer envelope",
      { issues: parsed.error.issues },
    );
  const receipt = parsed.data.lastCommit;
  if (receipt && !deepEqual(receipt.revision, revisionOf(parsed.data)))
    throw createWeaverError(
      "PROVIDER_CORRUPT",
      "Receipt does not match layer revision",
    );
  return parsed.data;
}

/** Check before Zod object construction so special own keys cannot be silently stripped. */
export function assertPersistedKeys(value: unknown): void {
  try {
    JSON.stringify(value);
  } catch {
    throw createWeaverError(
      "PROVIDER_CORRUPT",
      "Persisted values must be acyclic JSON",
    );
  }
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      try {
        assertSafePathSegment(key);
      } catch {
        throw createWeaverError(
          "PROVIDER_CORRUPT",
          "Unsafe persisted entry key",
          { key },
        );
      }
      pending.push(child);
    }
  }
}

export function mutationDigest(request: LayerCommitRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function prepareEnvelope(
  current: LayerEnvelope,
  request: LayerCommitRequest,
): LayerEnvelope {
  const path = normalizeStorageWritePath(request.mutation.key);
  if (!path.ok) throw createWeaverError("VALIDATION_ERROR", path.error.message);
  const digest = mutationDigest(request);
  if (current.lastCommit?.operationId === request.operationId) {
    if (current.lastCommit.mutationDigest !== digest)
      throw createWeaverError(
        "REVISION_CONFLICT",
        "Operation ID reused with a different request",
      );
    return current;
  }
  if (
    request.layer !== current.layer ||
    !deepEqual(request.expectedRevision, revisionOf(current))
  )
    throw createWeaverError("REVISION_CONFLICT", "Provider revision conflict");
  const entries: Record<string, unknown> = structuredClone(current.entries);
  if (request.mutation.action === "set")
    deepSet(entries, path.value, structuredClone(request.mutation.value));
  else deepRemove(entries, path.value);
  const next = parseEnvelope({
    ...current,
    entries,
    sequence: deepEqual(entries, current.entries)
      ? current.sequence
      : (BigInt(current.sequence) + 1n).toString(),
    lastCommit: undefined,
  });
  return {
    ...next,
    lastCommit: {
      operationId: request.operationId,
      previousRevision: revisionOf(current),
      revision: revisionOf(next),
      mutationDigest: digest,
    },
  };
}
