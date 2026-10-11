import {
  createRegisteredReadProjection,
  type RegisteredReadProjection,
} from "@weaver-conf/config-registry";
import type {
  ConfigurationPropertySchema,
  ConfigurationServiceIdentity,
} from "@weaver-conf/config-types";
import { type LoadedContribution, requireHealthy } from "./hydration";
import {
  type ResolutionContext,
  resolutionLayers,
  resolveRegisteredLayers,
} from "./resolution-context";

export interface IdentitySnapshot {
  readonly identity: ConfigurationServiceIdentity;
  readonly revision: string;
  readonly registryRevision: number;
  readonly resolution: ResolutionContext;
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
  resolution: ResolutionContext,
  failureMode: "fail" | "allow-degraded" | undefined,
): IdentitySnapshot {
  const { registry, registryRevision } = resolution;
  const degradedProviders = requireHealthy(contributions, failureMode);
  const snapshot = resolveIdentitySnapshot(contributions, resolution);
  const projection = createRegisteredReadProjection(registry, snapshot, {
    identity,
    revision,
  });
  return Object.freeze({
    identity,
    revision,
    degradedProviders,
    registryRevision,
    resolution,
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
  context: ResolutionContext,
) {
  return resolveRegisteredLayers(
    resolutionLayers(contributions, context),
    context,
  );
}
