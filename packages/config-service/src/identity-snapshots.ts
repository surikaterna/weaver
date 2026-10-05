import {
  type ResolutionLayer,
  resolveConfigurationSnapshot,
} from "@weaver-conf/config-engine";
import {
  type CanonicalSchemaRegistryReader,
  createRegisteredReadProjection,
  type RegisteredReadProjection,
} from "@weaver-conf/config-registry";
import type { ConfigurationServiceIdentity } from "@weaver-conf/config-types";
import { type LoadedContribution, requireHealthy } from "./hydration";

export interface IdentitySnapshot {
  readonly identity: ConfigurationServiceIdentity;
  readonly revision: string;
  readonly contributions: readonly LoadedContribution[];
  readonly degradedProviders: readonly string[];
  readonly projection: RegisteredReadProjection;
}
export function stageIdentity(
  identity: ConfigurationServiceIdentity,
  revision: string,
  contributions: readonly LoadedContribution[],
  registry: CanonicalSchemaRegistryReader,
  configuredRanks: readonly number[],
  failureMode: "fail" | "allow-degraded" | undefined,
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
    contributions: Object.freeze([...contributions]),
    projection,
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
