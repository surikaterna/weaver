import {
  parseCanonicalConfigPath,
  type ResolutionLayer,
  resolveConfigurationSnapshot,
} from "@weaver-conf/config-engine";
import {
  type RegistryProjectionReader,
  registeredCeilingEvidence,
} from "@weaver-conf/config-registry";
import {
  type ConfigurationServiceIdentity,
  createWeaverError,
} from "@weaver-conf/config-types";
import type { SessionReference } from "./authority/session-bindings";
import type { LoadedContribution } from "./hydration";
import { identityKey } from "./layer-stack";
import type { CapturedBinding } from "./provider-binding";
import type { RootState } from "./root-state";

export interface ResolutionContext {
  readonly registry: RegistryProjectionReader;
  readonly identity: ConfigurationServiceIdentity;
  readonly registryRevision: number;
  readonly layerNames: readonly string[];
  readonly configuredRanks: readonly number[];
  readonly sessions: ReadonlyMap<CapturedBinding, SessionReference>;
}

export function captureResolutionContext(
  state: RootState,
  identity: ConfigurationServiceIdentity,
  registry: RegistryProjectionReader = state.factory.registry,
  registryRevision = state.factory.adapter.revision,
): ResolutionContext {
  const sessions = new Map<CapturedBinding, SessionReference>();
  for (const ref of state.sessions.values()) {
    if (identityKey(ref.target.identity) !== identityKey(identity)) continue;
    try {
      ref.ownerCheck();
      if (ref.controller.isActive()) sessions.set(ref.selection.captured, ref);
    } catch {
      // Revoked creator epochs are an expected loss of eligibility, not failed IO.
    }
  }
  return Object.freeze({
    registry,
    identity,
    registryRevision,
    sessions,
    layerNames: Object.freeze(
      state.factory.options.layers.map((slot) => slot.layer),
    ),
    configuredRanks: Object.freeze(
      state.factory.options.layers.map((_, rank) => rank),
    ),
  });
}

export function resolutionLayers(
  contributions: readonly LoadedContribution[],
  context: ResolutionContext,
): ResolutionLayer[] {
  const layers: ResolutionLayer[] = [];
  for (const item of contributions) {
    if (!item.layer) continue;
    const ref = context.sessions.get(item.selection.captured);
    if (item.selection.kind === "session" && !ref) continue;
    if (ref) assertSessionSource(ref, item);
    layers.push({
      layer: item.layer.layer,
      providerId: item.layer.providerId,
      rank: item.selection.rank,
      entries: item.layer.entries,
      trustedEmergency: ref?.emergency === true,
    });
  }
  return layers;
}

export function resolveRegisteredLayers(
  layers: readonly ResolutionLayer[],
  context: ResolutionContext,
) {
  const evidence = registeredCeilingEvidence(context.registry, {
    environment: context.identity.environment,
    registryRevision: context.registryRevision,
    layerNames: context.layerNames,
    candidates: layers,
  });
  return resolveConfigurationSnapshot({
    layers,
    configuredRanks: context.configuredRanks,
    ceilings: evidence.ceilings,
  });
}

function assertSessionSource(
  ref: SessionReference,
  item: LoadedContribution,
): void {
  const target = parseCanonicalConfigPath(ref.target.namespace).segments;
  const path =
    ref.target.viewId === undefined
      ? target
      : [...target, "instances", ref.target.viewId];
  if (item.layer?.providerId !== ref.controller.provider.id || !path.length)
    throw createWeaverError(
      "INTERNAL_ERROR",
      "Session source confinement invariant",
    );
  let value: unknown = item.layer.entries;
  for (const segment of path) {
    if (value === undefined) return;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== segment)
    )
      throw createWeaverError(
        "INTERNAL_ERROR",
        "Session source confinement invariant",
      );
    value = Object.getOwnPropertyDescriptor(value, segment)?.value;
  }
}
