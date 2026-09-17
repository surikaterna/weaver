import {
  type ConfigurationStorageProvider,
  createWeaverError,
  type ProviderInventory,
  providerCapabilitiesSchema,
  providerInventorySchema,
  type ServiceAuthoritySnapshot,
  serviceAuthoritySnapshotSchema,
} from "@weaver-conf/config-types";
import { catalogLayers } from "./authority-preflight";
import type { ConfigServiceController } from "./config-service-controller";

function expectedLayers(
  host: ConfigServiceController,
  provider: ConfigurationStorageProvider,
): Set<string> {
  return new Set(
    host.inventory
      ? catalogLayers(host.providers, provider, host.inventory)
      : [provider.layer],
  );
}

function validateLayers(
  host: ConfigServiceController,
  provider: ConfigurationStorageProvider,
  inventory: ProviderInventory,
): void {
  const expected = expectedLayers(host, provider);
  const actual = inventory.revisions.map((revision) => revision.layer);
  if (
    actual.length !== expected.size ||
    actual.some((layer) => !expected.has(layer)) ||
    new Set(actual).size !== actual.length
  )
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      `Provider ${provider.id} inventory differs from the enforced context catalog`,
    );
}

/** Physical discovery covers cold and retired stores, not only materialized contexts. */
export async function initializeAuthorityInventory(
  host: ConfigServiceController,
): Promise<void> {
  if (!host.inventory) return;
  for (const context of Object.values(host.inventory.contexts))
    for (const scope of context.scopePath) {
      const layer = `${scope.scopeId}:${scope.value}`;
      const provider = host.resolveProvider(layer);
      if (!provider)
        throw createWeaverError(
          "UNSUPPORTED_AUTHORITY",
          `Missing provider for catalogued layer ${layer}`,
        );
      if (provider.authority) await provider.authority.readLayer(layer);
    }
  for (const provider of host.providers) {
    if (!provider.authority) continue;
    validateLayers(
      host,
      provider,
      providerInventorySchema.parse(await provider.authority.inventory()),
    );
  }
  await host.authority.captureMany(host.providers);
}

export async function collectAuthoritySnapshot(
  host: ConfigServiceController,
): Promise<ServiceAuthoritySnapshot> {
  host.assertReady();
  if (!host.inventory)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Complete scope inventory is unknown",
    );
  const providers: ServiceAuthoritySnapshot["providers"] = {};
  for (const provider of host.providers) {
    if (!provider.authority)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        `Provider ${provider.id} has no authority`,
      );
    const inventory = providerInventorySchema.parse(
      await provider.authority.inventory(),
    );
    validateLayers(host, provider, inventory);
    if (!host.authority.matches(provider, inventory))
      throw createWeaverError(
        "REVISION_CONFLICT",
        "Provider changed outside the captured authority vector",
      );
    Object.defineProperty(providers, provider.id, {
      value: {
        capabilities: providerCapabilitiesSchema.parse(
          provider.authority.capabilities,
        ),
        inventory,
      },
      enumerable: true,
    });
  }
  return serviceAuthoritySnapshotSchema.parse({
    revision: host.authority.revision(),
    inventory: host.inventory,
    providers,
  });
}
