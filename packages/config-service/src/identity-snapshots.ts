import {
  type ResolutionLayer,
  resolveConfigurationSnapshot,
} from "@weaver-conf/config-engine";
import {
  createRegisteredReadProjection,
  type RegisteredReadProjection,
  type RegistryProjectionReader,
} from "@weaver-conf/config-registry";
import type {
  ConfigurationPropertySchema,
  ConfigurationServiceIdentity,
} from "@weaver-conf/config-types";
import { type LoadedContribution, requireHealthy } from "./hydration";

export interface IdentitySnapshot {
  readonly identity: ConfigurationServiceIdentity;
  readonly revision: string;
  readonly registryRevision: number;
  readonly contributions: readonly LoadedContribution[];
  readonly degradedProviders: readonly string[];
  readonly projection: RegisteredReadProjection;
  readonly raw: ReturnType<typeof resolveIdentitySnapshot>;
  readonly sourceRaw?: ReturnType<typeof resolveIdentitySnapshot>;
  readonly reloadPolicies: readonly {
    readonly path: string;
    readonly schema: ConfigurationPropertySchema;
  }[];
}
export function stageIdentity(
  identity: ConfigurationServiceIdentity,
  revision: string,
  contributions: readonly LoadedContribution[],
  registry: RegistryProjectionReader,
  configuredRanks: readonly number[],
  failureMode: "fail" | "allow-degraded" | undefined,
  registryRevision: number,
): IdentitySnapshot {
  const degradedProviders = requireHealthy(contributions, failureMode);
  const snapshot = resolveIdentitySnapshot(contributions, configuredRanks);
  const projection = createRegisteredReadProjection(registry, snapshot, {
    identity,
    revision,
  });
  return Object.freeze({
    identity,
    revision,
    degradedProviders,
    registryRevision,
    contributions: Object.freeze([...contributions]),
    projection,
    raw: snapshot,
    reloadPolicies: Object.freeze(
      registry
        .listRegisteredSchemaIdentities()
        .anchors.filter((item) => item.environment === identity.environment)
        .flatMap((item) => {
          const anchor = registry.resolveAnchor(item.path, item.environment);
          return anchor
            ? [Object.freeze({ path: item.path, schema: anchor.schema })]
            : [];
        }),
    ),
  });
}

export function resolveIdentitySnapshot(
  contributions: readonly LoadedContribution[],
  configuredRanks: readonly number[],
) {
  const layers: ResolutionLayer[] = [];
  for (const item of contributions) if (item.layer) layers.push(item.layer);
  return resolveConfigurationSnapshot({
    layers,
    configuredRanks,
    ceilings: [],
  });
}
