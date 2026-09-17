import type {
  ConfigurationStorageProvider,
  InternalProviderDefinition,
} from "@weaver-conf/config-types";

const definitions = new WeakMap<
  ConfigurationStorageProvider,
  InternalProviderDefinition
>();

/** Retains the installed-code-validated definition on the opaque runtime provider handle. */
export function bindProviderDefinition(
  provider: ConfigurationStorageProvider,
  definition: InternalProviderDefinition,
): void {
  definitions.set(provider, structuredClone(definition));
}

export function trustedProviderDefinition(
  provider: ConfigurationStorageProvider,
): InternalProviderDefinition | undefined {
  const definition = definitions.get(provider);
  return definition ? structuredClone(definition) : undefined;
}
