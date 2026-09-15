import type { ConfigurationStorageProvider } from "@weaver-conf/config-types";

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
