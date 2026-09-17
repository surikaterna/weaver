import type { ConfigurationStorageProvider } from "@weaver-conf/config-types";
import type { ConfigServiceController } from "./config-service-controller";

export function providerFlushSteps(
  providers: readonly ConfigurationStorageProvider[],
) {
  return providers
    .filter((provider) => provider.flush && provider.dirty)
    .map((provider) => ({
      name: `replication:${provider.id}`,
      run: async () => {
        await provider.flush?.();
      },
    }));
}

export function serviceCloseSteps(host: ConfigServiceController) {
  return [
    ...host.maintenance.stopSteps(),
    ...providerFlushSteps(host.providers),
    { name: "provider owners", run: () => host.authority.close() },
    { name: "runtime", run: () => host.runtime.dispose() },
  ];
}
