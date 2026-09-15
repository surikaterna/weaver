import type { BootstrapCredentials } from "./bootstrap/seed-trust";

/** Environment values supply named credentials only, never an alternate server/layout configuration. */
export function bootstrapCredentialsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): BootstrapCredentials {
  const values = new Map(Object.entries(environment));
  return Object.freeze({
    resolveCredential: (reference: string) =>
      values.get(`WEAVER_CREDENTIAL_${reference}`),
  });
}
