import type {
  InternalUpgradePlannerInput,
  ProviderRevision,
  ScopeInstance,
} from "@weaver-conf/config-types";
import { mergeEntries, upgradePathSegments, valueAt } from "./upgrade-data";

export interface PhysicalLayer {
  readonly rank: number;
  readonly providerId: string;
  readonly namespace: string;
  readonly writable: boolean;
  readonly durable: boolean;
  readonly layer: string;
  readonly revision: ProviderRevision;
  readonly entries: Record<string, unknown>;
}

export function effectiveAnchor(
  input: InternalUpgradePlannerInput,
  physical: readonly PhysicalLayer[],
  context: readonly ScopeInstance[],
  anchor: string,
): unknown {
  return valueAt(
    effectiveEntries(input, physical, context),
    upgradePathSegments(anchor),
  );
}

export function effectiveEntries(
  input: InternalUpgradePlannerInput,
  physical: readonly PhysicalLayer[],
  context: readonly ScopeInstance[],
): Record<string, unknown> {
  const visible = physical
    .filter((layer) => visibleToContext(input, layer, context))
    .sort((a, b) => a.rank - b.rank);
  return mergeEntries(visible.map((layer) => layer.entries));
}

export function physicalLayers(
  input: InternalUpgradePlannerInput,
): readonly PhysicalLayer[] {
  return input.infrastructure.layout.layers.flatMap((definition, rank) => {
    if (["personal", "ephemeral"].includes(definition.type)) return [];
    const provider = input.providers.find(
      (item) => item.providerId === definition.providerId,
    );
    if (!provider) return [];
    return provider.layers.map((snapshot) => ({
      rank,
      providerId: provider.providerId,
      namespace:
        "namespace" in provider.capabilities
          ? provider.capabilities.namespace
          : provider.namespace,
      writable: provider.writable,
      durable: provider.capabilities.kind === "durable-exclusive",
      layer: snapshot.revision.layer,
      revision: snapshot.revision,
      entries: structuredClone(snapshot.entries),
    }));
  });
}

export function chooseSharedLayer(
  input: InternalUpgradePlannerInput,
  layers: readonly PhysicalLayer[],
  contexts: readonly (readonly ScopeInstance[])[],
): PhysicalLayer | undefined {
  return layers
    .filter(
      (layer) => layer.durable && layer.writable && !isControl(input, layer),
    )
    .filter((layer) =>
      contexts.every((context) => visibleToContext(input, layer, context)),
    )
    .sort((a, b) => a.rank - b.rank || a.layer.localeCompare(b.layer))[0];
}

export function visibleToContext(
  input: InternalUpgradePlannerInput,
  layer: PhysicalLayer,
  context: readonly ScopeInstance[],
): boolean {
  const definition = input.infrastructure.layout.layers[layer.rank];
  if (!definition) return false;
  if (definition.type === "static") return layer.layer === definition.name;
  if (definition.type !== "dynamic") return false;
  return context.some(
    (scope) => `${scope.scopeId}:${scope.value}` === layer.layer,
  );
}

function isControl(
  input: InternalUpgradePlannerInput,
  layer: PhysicalLayer,
): boolean {
  const definition = input.infrastructure.layout.layers[layer.rank];
  return (
    definition?.name === "control" ||
    (definition?.name === "platform" && layer.entries._weaver !== undefined)
  );
}
