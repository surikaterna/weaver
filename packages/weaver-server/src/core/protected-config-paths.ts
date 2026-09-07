import { parsePath } from "@weaver-conf/config-engine";
import type { WriteResult } from "@weaver-conf/config-types";

const protectedRoot = "_weaver";

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

export function isProtectedConfigPath(key: string): boolean {
  const firstSegment = getFirstLogicalPathSegment(key);
  return firstSegment === protectedRoot;
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
    Object.entries(scopes).map(([layer, entries]) => [
      layer,
      filterProtectedConfigEntries(entries),
    ]),
  );
}

function getFirstLogicalPathSegment(key: string): string | null {
  const normalized = key.startsWith("/") ? key.slice(1) : key;
  const path = normalized.replaceAll("/", ".");

  try {
    return parsePath(path)[0] ?? null;
  } catch {
    return null;
  }
}
