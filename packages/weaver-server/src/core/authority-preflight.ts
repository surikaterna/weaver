import { assertSafePathSegment } from "@weaver-conf/config-engine";
import {
  type ConfigurationStorageProvider,
  createWeaverError,
  type ProviderPreflight,
  providerCapabilitiesSchema,
  providerPreflightSchema,
  type ScopeInventory,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import {
  isSameScopeLayer,
  normalizeScopeLayer,
  parseScopeLayer,
} from "./scope-utils";

export function resolveAuthorityProvider(
  providers: readonly ConfigurationStorageProvider[],
  layer: string,
): ConfigurationStorageProvider | undefined {
  const direct = providers.find((provider) => provider.layer === layer);
  if (direct) return direct;
  const parsed = parseScopeLayer(layer);
  if (!parsed) return undefined;
  return (
    providers.find((provider) => isSameScopeLayer(provider.layer, layer)) ??
    providers.find((provider) => provider.layer === parsed.scopeId)
  );
}
export function catalogLayers(
  providers: readonly ConfigurationStorageProvider[],
  provider: ConfigurationStorageProvider,
  inventory: ScopeInventory,
): string[] {
  const layers = new Set<string>(
    parseScopeLayer(provider.layer) ? [] : [provider.layer],
  );
  for (const context of Object.values(inventory.contexts))
    for (const scope of context.scopePath) {
      const layer = `${scope.scopeId}:${scope.value}`;
      if (resolveAuthorityProvider(providers, layer) === provider)
        layers.add(layer);
    }
  if (!layers.has(normalizeScopeLayer(provider.layer)))
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      `Uncatalogued static scoped provider: ${provider.layer}`,
    );
  return [...layers].sort();
}
function descriptor(
  provider: ConfigurationStorageProvider,
  durable: boolean,
): void {
  assertSafePathSegment(provider.id);
  const parsed = providerCapabilitiesSchema.safeParse(
    provider.authority?.capabilities ??
      provider.capabilities ?? { kind: "unsupported", reason: "No authority" },
  );
  if (!parsed.success)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      `Invalid authority descriptor: ${provider.id}`,
    );
  const authority = provider.authority;
  if (durable && (!authority || parsed.data.kind !== "durable-exclusive"))
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      `Provider ${provider.id} cannot participate in durable authority`,
    );
  if (!authority) return;
  if (
    !["durable-exclusive", "volatile-exclusive"].includes(parsed.data.kind) ||
    [
      authority.preflight,
      authority.acquireWriter,
      authority.releaseWriter,
      authority.readLayer,
      authority.inventory,
      authority.commitLayer,
    ].some((method) => typeof method !== "function")
  )
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      `Incomplete exclusive authority: ${provider.id}`,
    );
}
function catalogPreflight(
  providers: readonly ConfigurationStorageProvider[],
  inventory?: ScopeInventory,
): Map<ConfigurationStorageProvider, string[]> {
  const expected = new Map<ConfigurationStorageProvider, string[]>();
  if (!inventory) return expected;
  for (const provider of providers)
    expected.set(provider, catalogLayers(providers, provider, inventory));
  for (const context of Object.values(inventory.contexts))
    for (const scope of context.scopePath) {
      if (
        !resolveAuthorityProvider(providers, `${scope.scopeId}:${scope.value}`)
      )
        throw createWeaverError(
          "UNSUPPORTED_AUTHORITY",
          "Scope inventory references a missing provider",
        );
    }
  return expected;
}
/** Complete pure composition checks precede all IO, and every read-only preflight precedes acquisition. */
export async function preflightAuthorities(
  providers: readonly ConfigurationStorageProvider[],
  durable: boolean,
  inventory?: ScopeInventory,
): Promise<ConfigurationStorageProvider[]> {
  if (
    new Set(providers.map((provider) => provider.id)).size !== providers.length
  )
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Provider IDs must be unique",
    );
  for (const provider of providers) descriptor(provider, durable);
  const expected = catalogPreflight(providers, inventory);
  const plans = new Map<ConfigurationStorageProvider, ProviderPreflight>();
  for (const provider of providers) {
    if (!provider.authority) continue;
    const plan = await readPreflight(provider, expected.get(provider));
    const layers = expected.get(provider);
    if (
      new Set(plan.layers).size !== plan.layers.length ||
      (layers &&
        (layers.length !== plan.layers.length ||
          layers.some((layer) => !plan.layers.includes(layer))))
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        `Physical preflight differs from catalog: ${provider.id}`,
      );
    plans.set(provider, plan);
  }
  assertDistinctNamespaces([...plans.values()]);
  return [...providers].sort((a, b) =>
    (plans.get(a)?.namespace ?? a.id).localeCompare(
      plans.get(b)?.namespace ?? b.id,
    ),
  );
}

async function readPreflight(
  provider: ConfigurationStorageProvider,
  layers?: readonly string[],
): Promise<ProviderPreflight> {
  try {
    return providerPreflightSchema.parse(
      await provider.authority?.preflight(layers),
    );
  } catch (error) {
    if (error instanceof WeaverErrorInstance) throw error;
    throw createWeaverError(
      "PROVIDER_LOAD_FAILED",
      `Provider preflight failed before acquisition: ${provider.id}`,
      { cause: String(error) },
    );
  }
}
function assertDistinctNamespaces(plans: readonly ProviderPreflight[]): void {
  for (const [index, plan] of plans.entries())
    for (const other of plans.slice(index + 1)) {
      if (
        plan.namespace === other.namespace ||
        plan.namespace.startsWith(`${other.namespace}/`) ||
        other.namespace.startsWith(`${plan.namespace}/`)
      )
        throw createWeaverError(
          "UNSUPPORTED_AUTHORITY",
          "Overlapping authority namespaces",
        );
    }
}
