import type { ConfigServiceController } from "./config-service-controller";

export function watchConfigurationProviders(host: ConfigServiceController) {
  return host.providers.flatMap((provider) => {
    // Exclusive authority forbids external writers/watchers; basic adapters need staged reloads.
    if (provider.authority || !provider.onExternalChange) return [];
    const dispose = provider.onExternalChange(() => {
      try {
        host.assertOpen();
      } catch {
        return;
      }
      host.coordinator
        .run(() => host.reload([provider], false))
        .catch((error) => {
          try {
            host.logger.error("[config] external candidate refused:", error);
          } catch {
            /* Diagnostics never reopen admission or publish a failed candidate. */
          }
        });
    });
    return [
      {
        name: `watch:${provider.id}`,
        run: async () => {
          dispose();
        },
      },
    ];
  });
}
