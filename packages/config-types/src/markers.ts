/** A reference to a secret stored in an external provider (vault, KMS, etc.). */
export interface SecretReference {
  readonly _weaver: "secret-ref";
  readonly provider: string;
  readonly uri: string;
  readonly version?: string | undefined;
}

/** A mount point that delegates resolution to another config source. */
export interface ConfigMount {
  readonly _weaver: "mount";
  readonly source: string;
}

/** Union of all Weaver marker types embedded in config values. */
export type WeaverMarker = SecretReference | ConfigMount;

/** Type guard — checks if a value is any Weaver marker (has `_weaver` discriminant). */
export function isWeaverMarker(value: unknown): value is WeaverMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    "_weaver" in value &&
    typeof (value as Record<string, unknown>)._weaver === "string" // SAFETY: duck-typing check for marker interface
  );
}

/** Type guard — checks if a value is a SecretReference marker. */
export function isSecretReference(value: unknown): value is SecretReference {
  return isWeaverMarker(value) && value._weaver === "secret-ref";
}

/** Type guard — checks if a value is a ConfigMount marker. */
export function isConfigMount(value: unknown): value is ConfigMount {
  return (
    isWeaverMarker(value) &&
    value._weaver === "mount" &&
    typeof value.source === "string"
  );
}
