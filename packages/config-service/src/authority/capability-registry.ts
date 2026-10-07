import {
  type ConfigurationAuthorityCapability,
  createWeaverError,
  type TrustedPrincipalSnapshot,
  trustedPrincipalSnapshotSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";

export function forbidden(): never {
  throw createWeaverError("FORBIDDEN", "Configuration authority denied");
}
interface Entry {
  readonly snapshot: TrustedPrincipalSnapshot;
  epoch: number;
}
export function createCapabilityRegistry(
  assertLive: () => void,
  now: () => number,
  onRevoked?: (token: ConfigurationAuthorityCapability) => void,
) {
  const entries = new WeakMap<object, Entry>();
  const schema = z.custom<ConfigurationAuthorityCapability>(
    (value) =>
      value !== null && typeof value === "object" && entries.has(value),
  );
  const member = (token: unknown): Entry => {
    assertLive();
    const parsed = schema.safeParse(token);
    if (!parsed.success) return forbidden();
    const entry = entries.get(parsed.data);
    if (!entry) return forbidden();
    return entry;
  };
  const current = (token: unknown): Entry => {
    const entry = member(token);
    assertCurrent(entry, now);
    return entry;
  };
  return {
    mint(input: TrustedPrincipalSnapshot): ConfigurationAuthorityCapability {
      assertLive();
      const snapshot = capturePrincipal(input);
      const token = Object.freeze({});
      entries.set(token, { snapshot, epoch: 0 });
      return schema.parse(token);
    },
    revoke(token: ConfigurationAuthorityCapability): void {
      member(token).epoch++;
      onRevoked?.(token);
    },
    current,
  };
}

function assertCurrent(entry: Entry, now: () => number): void {
  let time: number;
  try {
    time = now();
  } catch {
    forbidden();
  }
  if (
    !Number.isFinite(time) ||
    entry.epoch !== 0 ||
    (entry.snapshot.expiresAt !== undefined && time >= entry.snapshot.expiresAt)
  )
    forbidden();
}

function capturePrincipal(
  input: TrustedPrincipalSnapshot,
): TrustedPrincipalSnapshot {
  const parsed = trustedPrincipalSnapshotSchema.safeParse(input);
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid principal snapshot");
  return parsed.data;
}
