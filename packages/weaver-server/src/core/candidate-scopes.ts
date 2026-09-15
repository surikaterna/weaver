import {
  canonicalInternalJson,
  createWeaverError,
  providerInventorySchema,
  type ScopeInstance,
} from "@weaver-conf/config-types";
import { catalogLayers } from "./authority-preflight";
import type { CandidateLayers } from "./config-candidates";
import type { PreparedConfiguration } from "./config-contracts";
import type { ConfigServiceController } from "./config-service-controller";
import { scopeContextId, validateScopeInventory } from "./scope-inventory";

export function authoritativeContextPaths(
  prepared: PreparedConfiguration,
  expected?: readonly (readonly ScopeInstance[])[],
): ScopeInstance[][] {
  const inventory = validateScopeInventory(
    prepared.configuration.scopeInventory,
  );
  const paths = [
    [],
    ...Object.values(inventory.contexts).map((context) => context.scopePath),
  ].sort(comparePaths);
  const identities = paths.map((path) => scopeContextId(path));
  if (new Set(identities).size !== identities.length)
    throw createWeaverError("VALIDATION_ERROR", "Duplicate scope context");
  if (expected && !sameContexts(paths, expected))
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Upgrade context inventory differs from its bound plan",
    );
  return paths.map((path) => [...path]);
}

function sameContexts(
  actual: readonly (readonly ScopeInstance[])[],
  expected: readonly (readonly ScopeInstance[])[],
): boolean {
  const ordered = expected.map((path) => [...path]).sort(comparePaths);
  if (ordered.length !== actual.length) return false;
  if (
    new Set(ordered.map((path) => scopeContextId(path))).size !== ordered.length
  )
    return false;
  return canonicalInternalJson(actual) === canonicalInternalJson(ordered);
}

function comparePaths(
  left: readonly ScopeInstance[],
  right: readonly ScopeInstance[],
): number {
  return canonicalInternalJson(left).localeCompare(
    canonicalInternalJson(right),
  );
}

/** Ordinary activation uses already provisioned physical stores; it never creates or deletes stores. */
export async function stageCandidateScopes(
  host: ConfigServiceController,
  prepared: PreparedConfiguration,
  layers: CandidateLayers,
) {
  const inventory = validateScopeInventory(
    prepared.configuration.scopeInventory,
  );
  for (const provider of host.providers) {
    if (!provider.authority) continue;
    const actual = providerInventorySchema.parse(
      await provider.authority.inventory(),
    );
    const expected = catalogLayers(host.providers, provider, inventory);
    if (
      actual.revisions.length !== expected.length ||
      actual.revisions.some((stamp) => !expected.includes(stamp.layer))
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Scope storage must be initialized and inventoried before activation",
      );
  }
  const scoped = new Map(layers.scoped);
  const active = new Set<string>();
  for (const context of Object.values(inventory.contexts)) {
    for (const scope of context.scopePath)
      active.add(`${scope.scopeId}:${scope.value}`);
  }
  for (const layer of active) {
    const provider = host.resolveProvider(layer);
    if (!provider?.authority)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Scoped storage requires owned authority",
      );
    if (provider.layer !== layer && !scoped.has(layer))
      scoped.set(layer, (await host.authority.load(provider, layer)).entries);
  }
  return { scoped, active };
}
