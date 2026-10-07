import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import type { ConfigurationAuthorityCapability } from "@weaver-conf/config-types";
import {
  type ConfigurationReaderSelection,
  configurationNamespaceSchema,
  configurationReaderSelectionSchema,
  createWeaverError,
  relativeConfigurationPathSchema,
} from "@weaver-conf/config-types";
import { covers, identityMatches } from "./authority/authorization-requests";
import type { createCapabilityRegistry } from "./authority/capability-registry";
import { forbidden } from "./authority/capability-registry";
import { assertReadable, type RootState } from "./root-state";

export function readerLayers(
  state: RootState,
  selection: ConfigurationReaderSelection,
) {
  return state.factory.options.layers
    .filter(
      (slot) =>
        slot.kind === "fixed" || selection.identity.scopePath.length > 0,
    )
    .map((slot) => slot.layer);
}

export function captureReaderSelection(
  state: RootState,
  registry: ReturnType<typeof createCapabilityRegistry>,
  token: ConfigurationAuthorityCapability,
  input: ConfigurationReaderSelection,
): ConfigurationReaderSelection {
  assertReadable(state);
  const principal = registry.current(token).snapshot;
  const parsed = configurationReaderSelectionSchema.safeParse(input);
  if (!parsed.success) return forbidden();
  const selection = parsed.data;
  if (
    principal.session ||
    selection.identity.environment !==
      state.factory.options.identity.environment
  )
    return forbidden();
  const layers = readerLayers(state, selection);
  if (
    !principal.grants.some(
      (grant) =>
        identityMatches(grant.identity, selection.identity) &&
        covers(grant.namespace, selection.namespace) &&
        grant.operations.some(
          (operation) => operation === "read" || operation === "inspect",
        ) &&
        layers.every((layer) => grant.layers.includes(layer)) &&
        (selection.viewId === undefined
          ? grant.views.length === 0
          : grant.views.includes(selection.viewId)),
    )
  )
    return forbidden();
  registry.current(token);
  assertReadable(state);
  return selection;
}

export function readerPath(
  selection: ConfigurationReaderSelection,
  input: unknown,
) {
  const parsed = relativeConfigurationPathSchema.safeParse(input);
  if (!parsed.success)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Expected relative literal segments",
    );
  const segments = [
    ...parseCanonicalConfigPath(selection.namespace).segments,
    ...parsed.data,
  ];
  if (segments.includes("instances")) return forbidden();
  return configurationNamespaceSchema.parse(
    segments.length ? `/${segments.join("/")}` : "/",
  );
}
