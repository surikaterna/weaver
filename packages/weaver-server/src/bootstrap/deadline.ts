import { createWeaverError } from "@weaver-conf/config-types";

/** Injected resolvers cannot hold startup or its owned resources indefinitely. */
export async function withinBootstrapDeadline<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              createWeaverError(
                "CONFIG_NOT_READY",
                "Bootstrap dependency timed out",
              ),
            ),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
