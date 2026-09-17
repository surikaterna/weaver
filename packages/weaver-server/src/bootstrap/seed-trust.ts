import { createHash, timingSafeEqual } from "node:crypto";
import {
  type BootstrapSeed,
  bootstrapSeedSchema,
  canonicalInternalJson,
  createWeaverError,
} from "@weaver-conf/config-types";
import { withinBootstrapDeadline } from "./deadline";

/** Executable injection boundary. Secret values never enter declarative configuration. */
export interface BootstrapCredentials {
  resolveCredential(
    reference: string,
  ): Promise<string | undefined> | string | undefined;
}
export interface BootstrapAdministrator {
  readonly actor: string;
}
const administrators = new WeakMap<BootstrapAdministrator, string>();

export function parseBootstrapSeed(input: unknown): BootstrapSeed {
  const parsed = bootstrapSeedSchema.safeParse(input);
  if (!parsed.success)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid or unsupported bootstrap seed",
      { issues: parsed.error.issues },
    );
  return parsed.data;
}
export function bootstrapDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalInternalJson(JSON.parse(JSON.stringify(value))))
    .digest("hex");
}
export async function credential(
  credentials: BootstrapCredentials,
  reference: string,
): Promise<string> {
  let value: string | undefined;
  try {
    value = await withinBootstrapDeadline(() =>
      credentials.resolveCredential(reference),
    );
  } catch {
    throw createWeaverError(
      "UNAUTHORIZED",
      `Unavailable injected credential reference: ${reference}`,
    );
  }
  if (typeof value !== "string" || !value.length)
    throw createWeaverError(
      "UNAUTHORIZED",
      `Unavailable injected credential reference: ${reference}`,
    );
  return value;
}
export async function authenticateBootstrapAdministrator(
  seedInput: unknown,
  supplied: string,
  credentials: BootstrapCredentials,
): Promise<BootstrapAdministrator> {
  const seed = parseBootstrapSeed(seedInput);
  const expected = await credential(credentials, seed.trust.adminCredentialRef);
  if (expected.length < 32 || typeof supplied !== "string")
    throw createWeaverError(
      "UNAUTHORIZED",
      "Bootstrap administration requires a strong injected credential",
    );
  const left = createHash("sha256").update(supplied).digest();
  const right = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(left, right))
    throw createWeaverError(
      "UNAUTHORIZED",
      "Invalid bootstrap administrator credential",
    );
  const administrator = Object.freeze({ actor: "seed-administrator" });
  administrators.set(administrator, bootstrapDigest(seed));
  return administrator;
}
export function assertBootstrapAdministrator(
  seed: BootstrapSeed,
  administrator: BootstrapAdministrator,
): void {
  if (administrators.get(administrator) !== bootstrapDigest(seed))
    throw createWeaverError(
      "FORBIDDEN",
      "Administrator capability is not bound to this seed",
    );
}
