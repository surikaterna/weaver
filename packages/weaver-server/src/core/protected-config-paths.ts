import { isProtectedConfigPath } from "@weaver-conf/config-engine";
import type { WriteResult } from "@weaver-conf/config-types";

export { isProtectedConfigPath } from "@weaver-conf/config-engine";

export function protectedConfigMutationError(key: string): WriteResult | null {
  if (!isProtectedConfigPath(key)) return null;
  return {
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message: `Path "${key}" is reserved for Weaver internal metadata`,
    },
  };
}

export function filterProtectedConfigEntries(
  entries: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).filter(([key]) => !isProtectedConfigPath(key)),
  );
}

export function filterProtectedConfigScopes(
  scopes: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(scopes).map(([scope, entries]) => [
      scope,
      filterProtectedConfigEntries(entries),
    ]),
  );
}
