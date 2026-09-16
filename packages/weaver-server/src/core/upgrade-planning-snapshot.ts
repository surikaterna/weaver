import {
  canonicalInternalJson,
  createWeaverError,
  type InternalConfiguration,
  type ProviderInventory,
  providerInventorySchema,
} from "@weaver-conf/config-types";
import type { ConfigServiceController } from "./config-service-controller";
import type { WeaverConfigService } from "./config-service-types";

const hosts = new WeakMap<WeaverConfigService, ConfigServiceController>();

export function bindUpgradePlanningHost(
  service: WeaverConfigService,
  host: ConfigServiceController,
): void {
  hosts.set(service, host);
}

export function collectUpgradePlanningSnapshot(service: WeaverConfigService) {
  const host = hosts.get(service);
  if (!host)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "No internal upgrade planning capability",
    );
  return host.coordinator.runControl(() => collectStableSnapshot(host));
}

async function collectStableSnapshot(host: ConfigServiceController) {
  host.assertReady(true);
  const authorityRevision = host.authority.revision();
  const configuration = structuredClone(
    host.pipeline.contracts.prepared().configuration,
  );
  const inventories = await readInventories(host);
  const initiallyBound = inventories.every((record) =>
    inventoryMatchesAuthority(host, record),
  );
  const collected = await readProviderLayers(host, inventories);
  const envelopesStable = await verifyLayerRevisions(host, inventories);
  const finalInventories = await readInventories(host);
  const inventoriesStable =
    finalInventories.length === inventories.length &&
    finalInventories.every((record, index) => {
      const initial = inventories[index];
      return (
        initial?.providerId === record.providerId &&
        canonicalInternalJson(initial.inventory) ===
          canonicalInternalJson(record.inventory) &&
        inventoryMatchesAuthority(host, record)
      );
    });
  const finalConfiguration = host.pipeline.contracts.prepared().configuration;
  const stable = snapshotUnchanged(
    host,
    authorityRevision,
    configuration,
    finalConfiguration,
    initiallyBound,
    collected.stable,
    envelopesStable,
    inventoriesStable,
  );
  return {
    authorityRevision,
    configuration,
    providers: collected.providers,
    stable,
  };
}

function snapshotUnchanged(
  host: ConfigServiceController,
  authorityRevision: string,
  configuration: InternalConfiguration,
  finalConfiguration: InternalConfiguration,
  initiallyBound: boolean,
  collectedStable: boolean,
  envelopesStable: boolean,
  inventoriesStable: boolean,
): boolean {
  return (
    authorityRevision === host.authority.revision() &&
    canonicalInternalJson(configuration) ===
      canonicalInternalJson(finalConfiguration) &&
    serviceInventoryMatches(host, finalConfiguration.scopeInventory) &&
    initiallyBound &&
    collectedStable &&
    envelopesStable &&
    inventoriesStable
  );
}

async function readInventories(host: ConfigServiceController) {
  const result: {
    readonly providerId: string;
    readonly inventory: ProviderInventory;
  }[] = [];
  for (const provider of [...host.providers].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (!provider.authority)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        `Provider ${provider.id} has no planning authority`,
      );
    const inventory = providerInventorySchema.parse(
      await provider.authority.inventory(),
    );
    result.push({ providerId: provider.id, inventory });
  }
  return result;
}

async function verifyLayerRevisions(
  host: ConfigServiceController,
  inventories: readonly {
    readonly providerId: string;
    readonly inventory: ProviderInventory;
  }[],
): Promise<boolean> {
  let stable = true;
  for (const record of inventories) {
    const authority = host.providers.find(
      (provider) => provider.id === record.providerId,
    )?.authority;
    if (!authority) {
      stable = false;
      continue;
    }
    for (const revision of record.inventory.revisions) {
      const envelope = await authority.readLayer(revision.layer);
      if (!sameRevision(envelope, revision)) stable = false;
    }
  }
  return stable;
}

async function readProviderLayers(
  host: ConfigServiceController,
  inventories: readonly {
    readonly providerId: string;
    readonly inventory: ProviderInventory;
  }[],
) {
  const providers = [];
  let stable = true;
  for (const record of inventories) {
    const provider = host.providers.find(
      (item) => item.id === record.providerId,
    );
    const authority = provider?.authority;
    if (!provider || !authority) {
      stable = false;
      continue;
    }
    const layers = [];
    for (const revision of [...record.inventory.revisions].sort((a, b) =>
      a.layer.localeCompare(b.layer),
    )) {
      const envelope = await authority.readLayer(revision.layer);
      if (!sameRevision(envelope, revision)) stable = false;
      layers.push({ revision, entries: structuredClone(envelope.entries) });
    }
    const capabilities = authority.capabilities;
    providers.push({
      providerId: provider.id,
      namespace:
        "namespace" in capabilities ? capabilities.namespace : provider.id,
      writable: provider.writable,
      capabilities,
      layers,
    });
  }
  return { providers, stable };
}

function inventoryMatchesAuthority(
  host: ConfigServiceController,
  record: {
    readonly providerId: string;
    readonly inventory: ProviderInventory;
  },
): boolean {
  const provider = host.providers.find(
    (candidate) => candidate.id === record.providerId,
  );
  return !!provider && host.authority.matches(provider, record.inventory);
}

function serviceInventoryMatches(
  host: ConfigServiceController,
  inventory: unknown,
): boolean {
  return (
    host.inventory !== undefined &&
    canonicalInternalJson(host.inventory) === canonicalInternalJson(inventory)
  );
}

function sameRevision(
  envelope: {
    readonly storeId: string;
    readonly environment: string;
    readonly layer: string;
    readonly epoch: string;
    readonly sequence: string;
  },
  revision: typeof envelope,
): boolean {
  return (
    envelope.storeId === revision.storeId &&
    envelope.environment === revision.environment &&
    envelope.layer === revision.layer &&
    envelope.epoch === revision.epoch &&
    envelope.sequence === revision.sequence
  );
}
