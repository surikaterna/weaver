import {
  type ConfigurationStorageProvider,
  createWeaverError,
  type ProviderAuthority,
  type WriteResult,
} from "@weaver-conf/config-types";
import { leasedProviderSource, providerSource } from "./config-provider-source";
import type { ConfigServiceController } from "./config-service-controller";

type OperationLease = Parameters<typeof leasedProviderSource>[1];

export function createProviderFacades(
  host: ConfigServiceController,
): readonly ConfigurationStorageProvider[] {
  return Object.freeze(
    providerSource(host).map((provider) => providerFacade(host, provider)),
  );
}

function rawProvider(
  host: ConfigServiceController,
  lease: OperationLease,
  providerId: string,
): ConfigurationStorageProvider {
  const provider = leasedProviderSource(host, lease).find(
    (candidate) => candidate.id === providerId,
  );
  if (!provider)
    throw createWeaverError("FORBIDDEN", "Provider source is unavailable");
  return provider;
}

function providerFacade(
  host: ConfigServiceController,
  provider: ConfigurationStorageProvider,
): ConfigurationStorageProvider {
  const deny = deniedProviderOperation(host);
  const facade: ConfigurationStorageProvider = {
    id: provider.id,
    layer: provider.layer,
    writable: provider.writable,
    ...(provider.capabilities
      ? { capabilities: Object.freeze(structuredClone(provider.capabilities)) }
      : {}),
    ...(provider.authority
      ? { authority: authorityFacade(host, provider.id, provider.authority) }
      : {}),
    get dirty() {
      return false;
    },
    load: () =>
      host.coordinator.runApplication((lease) =>
        rawProvider(host, lease, provider.id).load(),
      ),
    ...(provider.loadLayer ? layerReadFacade(host, provider.id) : {}),
    write: denyWrite(deny),
    remove: denyWrite(deny),
    ...(provider.writeLayer ? { writeLayer: denyLayerWrite(deny) } : {}),
    ...(provider.removeLayer ? { removeLayer: denyLayerWrite(deny) } : {}),
    ...(provider.refresh ? { refresh: deny } : {}),
    ...(provider.flush ? { flush: deny } : {}),
    ...(provider.onExternalChange ? watchDenial(host) : {}),
  };
  return Object.freeze(facade);
}

function layerReadFacade(host: ConfigServiceController, providerId: string) {
  return {
    loadLayer: (layer: string) =>
      host.coordinator.runApplication((lease) => {
        const provider = rawProvider(host, lease, providerId);
        if (!provider.loadLayer)
          throw createWeaverError(
            "FORBIDDEN",
            "Provider layer read is unavailable",
          );
        return provider.loadLayer(layer);
      }),
  };
}

function authorityFacade(
  host: ConfigServiceController,
  providerId: string,
  authority: ProviderAuthority,
): ProviderAuthority {
  const raw = (lease: OperationLease) => {
    const candidate = rawProvider(host, lease, providerId).authority;
    if (!candidate)
      throw createWeaverError("FORBIDDEN", "Provider authority is unavailable");
    return candidate;
  };
  const deny = deniedAuthorityOperation(host);
  return Object.freeze({
    capabilities: Object.freeze(structuredClone(authority.capabilities)),
    preflight: (layers?: readonly string[]) =>
      host.coordinator.runApplication((lease) => raw(lease).preflight(layers)),
    ...(authority.inspectOwnership ? ownershipInspection(host, raw) : {}),
    ...(authority.releaseQuarantinedWriter
      ? { releaseQuarantinedWriter: deny }
      : {}),
    acquireWriter: deny,
    releaseWriter: deny,
    readLayer: (layer: string) =>
      host.coordinator.runApplication((lease) => raw(lease).readLayer(layer)),
    inventory: () =>
      host.coordinator.runApplication((lease) => raw(lease).inventory()),
    commitLayer: deny,
  });
}

function ownershipInspection(
  host: ConfigServiceController,
  raw: (lease: OperationLease) => ProviderAuthority,
) {
  return {
    inspectOwnership: () =>
      host.coordinator.runApplication((lease) => {
        const inspect = raw(lease).inspectOwnership;
        if (!inspect)
          throw createWeaverError(
            "FORBIDDEN",
            "Provider ownership inspection is unavailable",
          );
        return inspect.call(raw(lease));
      }),
  };
}

function watchDenial(host: ConfigServiceController) {
  return {
    onExternalChange: () => {
      host.coordinator.assertApplicationAccess();
      throw createWeaverError(
        "FORBIDDEN",
        "Direct provider watches are unavailable",
      );
    },
  };
}

function deniedProviderOperation(host: ConfigServiceController) {
  return (): Promise<never> =>
    deny(host, "Direct provider mutation is unavailable");
}

function deniedAuthorityOperation(host: ConfigServiceController) {
  return (): Promise<never> =>
    deny(host, "Direct provider authority is unavailable");
}

function deny(host: ConfigServiceController, message: string): Promise<never> {
  host.coordinator.assertApplicationAccess();
  return Promise.reject(createWeaverError("FORBIDDEN", message));
}

function denyWrite(denial: () => Promise<never>) {
  return (_key: string, _value?: unknown): Promise<WriteResult> => denial();
}

function denyLayerWrite(denial: () => Promise<never>) {
  return (
    _layer: string,
    _key: string,
    _value?: unknown,
  ): Promise<WriteResult> => denial();
}
