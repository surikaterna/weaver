import {
  createWeaverError,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";

/** Every independent cleanup runs; the initiating failure remains the primary diagnostic. */
export async function runIndependentCleanup(
  steps: readonly {
    readonly name: string;
    readonly run: () => Promise<void>;
  }[],
  primary?: unknown,
): Promise<void> {
  const failures: {
    name: string;
    message: string;
    details?: Record<string, unknown>;
  }[] = [];
  let first: unknown = primary;
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      first ??= error;
      failures.push({
        name: step.name,
        message: String(error),
        ...(error instanceof WeaverErrorInstance && error.details
          ? { details: error.details }
          : {}),
      });
    }
  }
  if (primary === undefined && failures.length === 0) return;
  const code =
    first instanceof WeaverErrorInstance ? first.code : "INTERNAL_ERROR";
  throw createWeaverError(code, String(first), {
    primary: {
      code,
      message: first instanceof Error ? first.message : String(first),
      ...(first instanceof WeaverErrorInstance && first.details
        ? { details: first.details }
        : {}),
    },
    cleanup: failures,
  });
}
