import { z } from "zod";

interface NodeError extends Error {
  errno?: number;
  code?: string;
  path?: string;
  syscall?: string;
}

// Structural validation preserves inherited fields and all JavaScript numbers.
const nodeErrorSchema = z.custom<NodeError>((err: unknown) => {
  if (!(err instanceof Error) || !("code" in err)) return false;
  if (err.code !== undefined && typeof err.code !== "string") return false;
  if (
    "errno" in err &&
    err.errno !== undefined &&
    typeof err.errno !== "number"
  )
    return false;
  if ("path" in err && err.path !== undefined && typeof err.path !== "string")
    return false;
  if (
    "syscall" in err &&
    err.syscall !== undefined &&
    typeof err.syscall !== "string"
  )
    return false;
  return true;
});

/**
 * Extract a human-readable message from an unknown caught value.
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Type guard for Node.js system errors (ENOENT, EACCES, etc.).
 */
export function isNodeError(err: unknown): err is NodeError {
  return nodeErrorSchema.safeParse(err).success;
}
