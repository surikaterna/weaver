import { resolveConfiguration } from "@weaver-conf/config-engine";
import { createScopeResolver } from "@weaver-conf/config-runtime";
import type {
  ConfigurationStorageProvider,
  LayerDefinition,
  ScopeInstance,
} from "@weaver-conf/config-types";
import type { PreparedConfiguration } from "./config-contracts";
import { filterProtectedConfigEntries } from "./protected-config-paths";

export interface CandidateLayers {
  readonly base: ReadonlyMap<string, Record<string, unknown>>;
  readonly scoped: ReadonlyMap<string, Record<string, unknown>>;
}
/** Live reads and candidate validation use the same ordered stack builder and installed merge functions. */
export function mergeCandidate(
  prepared: PreparedConfiguration,
  providers: readonly ConfigurationStorageProvider[],
  layers: CandidateLayers,
  path: readonly ScopeInstance[] = [],
): Record<string, unknown> {
  const generation =
    prepared.configuration.infrastructure.generations[
      prepared.configuration.infrastructure.activeGeneration
    ];
  const getLayerEntries = (name: string, compiled?: LayerDefinition) => {
    const definition = generation?.layout.layers.find(
      (layer) => layer.name === (compiled?.name ?? name),
    );
    const provider = definition
      ? providers.find((entry) => entry.id === definition.providerId)
      : providers.find((entry) => entry.layer === name);
    if (!provider) return {};
    if (provider.layer.includes(":"))
      return name === definition?.name &&
        path.some(
          (scope) => `${scope.scopeId}:${scope.value}` === provider.layer,
        )
        ? filterProtectedConfigEntries(layers.base.get(provider.id) ?? {})
        : {};
    const entries =
      name === definition?.name
        ? layers.base.get(provider.id)
        : name.startsWith(`${provider.layer}:`)
          ? layers.scoped.get(name)
          : undefined;
    return filterProtectedConfigEntries(entries ?? {});
  };
  const resolver = createScopeResolver({
    weaverConfig: prepared.layout,
    getLayerEntries,
  });
  return resolveConfiguration(resolver.buildScopedStack([...path])).entries;
}
