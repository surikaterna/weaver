import type {
  InternalUpgradePlannerInput,
  InternalUpgradeRefusal,
} from "@weaver-conf/config-types";
import { deepEqual } from "./deep-equal";
import { compileInternalRegistrations } from "./internal-catalog";

export function validateUpgradeProviders(
  input: InternalUpgradePlannerInput,
): InternalUpgradeRefusal[] {
  const namespaces = new Set<string>();
  for (const provider of input.providers) {
    if (namespaces.has(provider.namespace))
      return [
        refusal(
          "ambiguous-placement",
          `Duplicate physical namespace ${provider.namespace}`,
        ),
      ];
    namespaces.add(provider.namespace);
    if (
      !("namespace" in provider.capabilities) ||
      provider.namespace !== provider.capabilities.namespace
    )
      return [
        refusal(
          "stale-binding",
          `Provider ${provider.providerId} namespace does not match authority`,
        ),
      ];
    if (hasContradictoryLayers(provider))
      return [
        refusal(
          "stale-binding",
          `Provider ${provider.providerId} has contradictory physical layers`,
        ),
      ];
  }
  return [];
}

export function infrastructureBindingsMatch(
  input: InternalUpgradePlannerInput,
): boolean {
  const declared = new Set(
    input.infrastructure.layout.layers.map((layer) => layer.providerId),
  );
  if (declared.size !== input.providers.length) return false;
  if (input.providers.some((provider) => !declared.has(provider.providerId)))
    return false;
  return input.infrastructure.layout.layers.every((definition) => {
    const provider = input.providers.find(
      (candidate) => candidate.providerId === definition.providerId,
    );
    if (!provider) return false;
    if (definition.type === "static")
      return provider.layers.some(
        (layer) => layer.revision.layer === definition.name,
      );
    if (definition.type !== "dynamic") return true;
    return provider.layers.every(
      (layer) =>
        layer.revision.layer === definition.name ||
        inventoryOwnsLayer(input, definition.name, layer.revision.layer),
    );
  });
}

export function schemasMatchCatalog(
  input: InternalUpgradePlannerInput,
): boolean | "invalid-default" {
  try {
    const source = compileInternalRegistrations(input.sourceCatalog);
    const target = compileInternalRegistrations(input.targetCatalog);
    const bindings = new Map(
      input.schemas.map((binding) => [
        `${binding.path}:${binding.environment}`,
        binding,
      ]),
    );
    const keys = new Set([...source.keys(), ...target.keys()]);
    if (keys.size !== bindings.size) return false;
    return [...keys].every((key) => {
      const binding = bindings.get(key);
      return (
        !!binding &&
        deepEqual(binding.source, source.get(key)) &&
        deepEqual(binding.target, target.get(key))
      );
    });
  } catch {
    return "invalid-default";
  }
}

function hasContradictoryLayers(
  provider: InternalUpgradePlannerInput["providers"][number],
): boolean {
  return (
    provider.layers.some(
      (layer) =>
        layer.revision.storeId !== provider.layers[0]?.revision.storeId,
    ) ||
    new Set(provider.layers.map((layer) => layer.revision.layer)).size !==
      provider.layers.length
  );
}

function inventoryOwnsLayer(
  input: InternalUpgradePlannerInput,
  scopeId: string,
  layer: string,
): boolean {
  return Object.values(input.inventory.contexts).some((context) =>
    context.scopePath.some(
      (scope) =>
        scope.scopeId === scopeId &&
        `${scope.scopeId}:${scope.value}` === layer,
    ),
  );
}

function refusal(
  code: InternalUpgradeRefusal["code"],
  message: string,
): InternalUpgradeRefusal {
  return { code, message };
}
