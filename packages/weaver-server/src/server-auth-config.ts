import {
  type ConfigurationStorageProvider,
  defineWeaver,
  Layers,
  type WeaverConfig,
} from "@weaver-conf/config-types";
import { hasScopedLayerIo } from "./core/config-service-internal";
import { parseScopeLayer } from "./core/scope-utils";

/** Authorization slots come from actual bootstrap providers, not a legacy rank profile. */
export function captureServerAuthConfig(
  providers: readonly ConfigurationStorageProvider[],
): WeaverConfig {
  const names = Object.freeze([
    ...new Set(providers.map((provider) => provider.layer)),
  ]);
  const dynamic = new Set(
    providers
      .filter(
        (provider) =>
          !parseScopeLayer(provider.layer) && hasScopedLayerIo(provider),
      )
      .map((provider) => provider.layer),
  );
  const configured = defineWeaver(
    Object.freeze(
      names.map((name) =>
        Object.freeze(
          dynamic.has(name) ? Layers.Dynamic(name) : Layers.Static(name),
        ),
      ),
    ),
  );
  Object.freeze(configured.layerNames);
  return Object.freeze({
    ...configured,
    rankMap: readonlyRanks(configured.rankMap),
    getRank(layer: string): number {
      const exact = configured.getRank(layer);
      if (exact >= 0) return exact;
      const scope = parseScopeLayer(layer);
      return scope && dynamic.has(scope.scopeId)
        ? configured.getRank(scope.scopeId)
        : -1;
    },
  });
}

function readonlyRanks(
  source: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const ranks: ReadonlyMap<string, number> = Object.freeze({
    get size() {
      return source.size;
    },
    get: (name: string) => source.get(name),
    has: (name: string) => source.has(name),
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    [Symbol.iterator]: () => source[Symbol.iterator](),
    forEach(
      callback: (
        rank: number,
        name: string,
        map: ReadonlyMap<string, number>,
      ) => void,
      thisArg?: unknown,
    ) {
      for (const [name, rank] of source)
        callback.call(thisArg, rank, name, ranks);
    },
  });
  return ranks;
}
