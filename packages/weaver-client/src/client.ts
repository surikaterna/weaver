import { createClientFacade } from "./client-facade";
import { initializeClientRuntime } from "./client-runtime";
import type { WeaverClient, WeaverClientOptions } from "./client-types";

export type { WeaverClient, WeaverClientOptions } from "./client-types";

/** Creates and boots a Weaver client. */
export async function createWeaverClient(
  options: WeaverClientOptions,
): Promise<WeaverClient> {
  return createClientFacade(await initializeClientRuntime(options));
}
