import { parsePath } from "@weaver-conf/config-engine";
import type { WriteResult } from "@weaver-conf/config-types";

const protectedRoot = "_weaver";

export function protectedConfigMutationError(key: string): WriteResult | null {
  if (!isProtectedConfigMutationKey(key)) return null;
  return {
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message: `Path "${key}" is reserved for Weaver internal metadata`,
    },
  };
}

function isProtectedConfigMutationKey(key: string): boolean {
  const firstSegment = getFirstLogicalPathSegment(key);
  return firstSegment === protectedRoot;
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
