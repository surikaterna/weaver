import {
  type ConfigurationStorageProvider,
  createWeaverError,
} from "@weaver-conf/config-types";
import type {
  ApplicationOperationLease,
  ControlOperationLease,
} from "./config-operation-lease";

interface ProviderSource {
  readonly providers: readonly ConfigurationStorageProvider[];
  readonly authorize: (
    lease: ApplicationOperationLease | ControlOperationLease,
  ) => void;
}
const sources = new WeakMap<object, ProviderSource>();

export function bindProviderSource(
  owner: object,
  providers: readonly ConfigurationStorageProvider[],
  authorize: ProviderSource["authorize"],
): void {
  if (sources.has(owner))
    throw createWeaverError("FORBIDDEN", "Provider source is already bound");
  sources.set(owner, {
    providers: Object.freeze([...providers]),
    authorize,
  });
}

export function providerSource(
  owner: object,
): readonly ConfigurationStorageProvider[] {
  const source = sources.get(owner);
  if (!source)
    throw createWeaverError("FORBIDDEN", "Provider source is unavailable");
  return source.providers;
}

export function leasedProviderSource(
  owner: object,
  lease: ApplicationOperationLease | ControlOperationLease,
): readonly ConfigurationStorageProvider[] {
  const source = sources.get(owner);
  if (!source)
    throw createWeaverError("FORBIDDEN", "Provider source is unavailable");
  source.authorize(lease);
  return source.providers;
}
