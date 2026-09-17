import type {
  InternalLayerDefinition,
  ScopeInstance,
} from "@weaver-conf/config-types";
import type { ConfigServiceController } from "./config-service-controller";
import type { ConfigInspectionLayer } from "./public-config-inspection";
import { normalizeScopeLayer, parseScopeLayer } from "./scope-utils";

/** Retired data stays in storage/cache, but only active full contexts authorize inspection. */
export function activeInspectionLayers(
  host: ConfigServiceController,
): ConfigInspectionLayer[] {
  const state = host.pipeline.contracts.prepared().configuration;
  const generation =
    state.infrastructure.generations[state.infrastructure.activeGeneration];
  const paths = Object.values(state.scopeInventory.contexts)
    .filter((context) => context.state === "active")
    .map((context) => context.scopePath);
  return (generation?.layout.layers ?? []).flatMap((definition) =>
    inspectionDefinition(host, definition, paths),
  );
}

function inspectionDefinition(
  host: ConfigServiceController,
  definition: InternalLayerDefinition,
  paths: readonly ScopeInstance[][],
): ConfigInspectionLayer[] {
  const provider = host.providers.find(
    (item) => item.id === definition.providerId,
  );
  if (!provider) return [];
  const active =
    definition.type === "dynamic"
      ? paths.filter((path) =>
          definition.config.scopeIds.every((id) =>
            path.some((scope) => scope.scopeId === id),
          ),
        )
      : paths;
  if (definition.type === "dynamic" && !active.length) return [];
  const physical = new Set(
    active.flatMap((path) =>
      path.map((scope) => `${scope.scopeId}:${scope.value}`),
    ),
  );
  const layer = normalizeScopeLayer(provider.layer);
  if (parseScopeLayer(layer) && !physical.has(layer)) return [];
  const layers: ConfigInspectionLayer[] = [
    { layer, entries: host.layerData.get(provider.id) ?? {} },
  ];
  for (const [name, entries] of host.dynamicScopeEntries) {
    if (
      host.resolveProvider(name) === provider &&
      physical.has(normalizeScopeLayer(name))
    )
      layers.push({ layer: normalizeScopeLayer(name), entries });
  }
  return layers;
}
