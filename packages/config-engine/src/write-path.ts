import {
  err,
  ok,
  type Result,
  type WriteError,
} from "@weaver-conf/config-types";
import { buildPath, parsePath } from "./path";

/** Validate before selecting storage or mutating a candidate, including untyped callers. */
export function normalizeStorageWritePath(
  key: unknown,
): Result<string, WriteError> {
  try {
    if (typeof key !== "string")
      return err({
        code: "VALIDATION_ERROR",
        message: "Path must be a string",
      });
    return ok(buildPath(parsePath(key)));
  } catch (error) {
    return err({
      code: "VALIDATION_ERROR",
      message:
        error instanceof Error ? error.message : "Invalid configuration path",
    });
  }
}
