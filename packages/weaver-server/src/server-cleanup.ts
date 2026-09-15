import { runIndependentCleanup } from "@weaver-conf/config-engine";
import type { WeaverConfigService } from "./core/config-service-types";
import { disposeRuntimeResolutionContexts } from "./core/runtime-resolution-contexts";
import type { HttpServer } from "./http-server";
import type { SSEAdapter } from "./transport/sse-adapter";

/** Closing config admission cannot be skipped by an earlier replication or transport failure. */
export async function cleanupServer(
  service: WeaverConfigService,
  disposeBootstrap: () => Promise<void>,
  sse?: SSEAdapter,
  server?: HttpServer,
  primary?: unknown,
): Promise<void> {
  await runIndependentCleanup(
    [
      {
        name: "config admission and owners",
        run: () => (service.close ? service.close() : service.flush()),
      },
      {
        name: "SSE",
        run: async () => {
          sse?.stopCheckpointTimer();
          sse?.closeAll();
        },
      },
      {
        name: "HTTP",
        run: async () => {
          await server?.stop();
        },
      },
      { name: "runtime", run: () => disposeRuntimeResolutionContexts(service) },
      { name: "bootstrap", run: disposeBootstrap },
    ],
    primary,
  );
}
