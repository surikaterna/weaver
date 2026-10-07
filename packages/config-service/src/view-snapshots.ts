import {
  inspectResolvedPath,
  parseCanonicalConfigPath,
  type ResolutionLayer,
  resolveConfigurationSnapshot,
  validateEffectiveConfiguration,
} from "@weaver-conf/config-engine";
import {
  createRegisteredReadProjection,
  type RegisteredMutationEvidence,
  type RegistryProjectionReader,
  registeredMutationEvidence,
} from "@weaver-conf/config-registry";
import {
  type ConfigurationPropertySchema,
  type ConfigurationReaderSelection,
  canonicalConfigurationPathSchema,
  createWeaverError,
  type WeaverErrorCode,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import type { IdentitySnapshot } from "./identity-snapshots";
import { currentIdentity } from "./identity-state";
import { identityKey } from "./layer-stack";
import { assertReadable, type RootState } from "./root-state";

export type PreparedView = Readonly<
  {
    selection: ConfigurationReaderSelection;
    base: IdentitySnapshot;
  } & (
    | { status: "ready"; snapshot: IdentitySnapshot }
    | { status: "unavailable"; code: WeaverErrorCode }
  )
>;

function viewKey(selection: ConfigurationReaderSelection): string {
  return JSON.stringify([
    identityKey(selection.identity),
    selection.namespace,
    selection.viewId,
  ]);
}

export function selectedSnapshot(
  state: RootState,
  selection: ConfigurationReaderSelection,
): IdentitySnapshot {
  const base = currentIdentity(state, selection.identity);
  if (selection.viewId === undefined) return base;
  const view = state.views.get(viewKey(selection));
  if (!view || view.base !== base)
    throw createWeaverError(
      "SCOPE_NOT_LOADED",
      "View selection is not prepared",
    );
  if (view.status === "unavailable")
    throw createWeaverError(view.code, "View selection is unavailable");
  return view.snapshot;
}

export function prepareView(
  state: RootState,
  selection: ConfigurationReaderSelection,
  guard: () => void,
): Promise<void> {
  return state.queue.enqueue(() => {
    assertReadable(state);
    guard();
    const base = currentIdentity(state, selection.identity);
    const existing = state.views.get(viewKey(selection));
    if (existing?.base === base && existing.status === "ready") return;
    const snapshot = deriveView(base, selection, state.factory.registry, false);
    assertReadable(state);
    guard();
    state.views.set(
      viewKey(selection),
      Object.freeze({ selection, base, status: "ready", snapshot }),
    );
  });
}

export function stageViews(
  views: ReadonlyMap<string, PreparedView>,
  ready: ReadonlyMap<string, IdentitySnapshot>,
  registry: RegistryProjectionReader,
  strict: boolean,
  validate = strict,
): Map<string, PreparedView> {
  const staged = new Map(views);
  for (const [key, previous] of views) {
    const base = ready.get(identityKey(previous.selection.identity));
    if (!base || previous.base === base) continue;
    const selection = previous.selection;
    try {
      const snapshot = deriveView(base, selection, registry, validate);
      staged.set(
        key,
        Object.freeze({ selection, base, status: "ready", snapshot }),
      );
    } catch (error) {
      if (strict && previous.status === "ready") throw error;
      const code =
        error instanceof WeaverErrorInstance ? error.code : "VALIDATION_ERROR";
      staged.set(
        key,
        Object.freeze({ selection, base, status: "unavailable", code }),
      );
    }
  }
  return staged;
}

export function deriveView(
  base: IdentitySnapshot,
  selection: ConfigurationReaderSelection,
  registry: RegistryProjectionReader,
  validate: boolean,
): IdentitySnapshot {
  if (selection.viewId === undefined || selection.namespace === "/")
    throw createWeaverError("FORBIDDEN", "A view requires a nonroot namespace");
  const namespace = canonicalConfigurationPathSchema.parse(selection.namespace);
  const logical = parseCanonicalConfigPath(namespace).segments;
  const physical = [...logical, "instances", selection.viewId];
  const schemas = declaredObject(base, logical, registry);
  declaredObject(base, physical, registry);
  const layers = viewLayers(base, logical, physical);
  const raw = resolveConfigurationSnapshot({
    layers,
    configuredRanks: [...new Set(base.raw.layers.map((layer) => layer.rank))],
    ceilings: [],
  });
  if (validate)
    validateView(
      schemas,
      inspectResolvedPath(raw, logical).effectiveValue,
      logical,
    );
  const projection = createRegisteredReadProjection(
    registry,
    raw,
    { identity: base.identity, revision: base.revision },
    { snapshot: base.raw, namespace, viewId: selection.viewId },
  );
  return Object.freeze({ ...base, sourceRaw: base.raw, raw, projection });
}

function declaredObject(
  base: IdentitySnapshot,
  path: readonly string[],
  registry: RegistryProjectionReader,
): readonly ConfigurationPropertySchema[] {
  const schemas: ConfigurationPropertySchema[] = [];
  let declared = false;
  for (const identity of registry.listRegisteredSchemaIdentities().anchors) {
    if (identity.environment !== base.identity.environment) continue;
    const root = parseCanonicalConfigPath(identity.path).segments;
    if (
      root.length > path.length ||
      !root.every((part, index) => path[index] === part)
    )
      continue;
    const anchor = registry.resolveAnchor(identity.path, identity.environment);
    if (!anchor)
      throw createWeaverError(
        "SCHEMA_NOT_REGISTERED",
        "View schema is unavailable",
      );
    const evidence = registeredMutationEvidence(
      anchor.schema,
      path.slice(root.length),
      inspectResolvedPath(base.raw, root).effectiveValue,
    );
    requireObjectEvidence(evidence);
    schemas.push(...evidence.schemas);
    declared = true;
  }
  if (!declared)
    throw createWeaverError(
      "SCHEMA_NOT_REGISTERED",
      "View path is not declared",
    );
  requireObject(inspectResolvedPath(base.raw, path).effectiveValue);
  return schemas;
}

function requireObjectEvidence(evidence: RegisteredMutationEvidence): void {
  if (!evidence.declared)
    throw createWeaverError(
      "SCHEMA_NOT_REGISTERED",
      "View path is not declared",
    );
  // Invalid values may leave alternatives unresolved. All captured branches
  // must still be object-capable; payload authorization remains query-local.
  if (evidence.reference || !evidence.containers.includes("object"))
    throw createWeaverError(
      "FORBIDDEN",
      "View namespace must be object-capable",
    );
}

function viewLayers(
  base: IdentitySnapshot,
  logical: readonly string[],
  physical: readonly string[],
): ResolutionLayer[] {
  const baseValues = inspectResolvedPath(base.raw, logical).contributions;
  const viewValues = inspectResolvedPath(base.raw, physical).contributions;
  const tier = (
    values: typeof baseValues,
    sourcePath: readonly string[],
    strip: boolean,
  ) =>
    base.raw.layers.map((layer, index) => {
      const value = values[index]?.value;
      requireObject(value);
      const entries =
        value === undefined
          ? {}
          : nest(logical, strip ? withoutStorage(value) : value);
      return { ...layer, sourcePath, entries };
    });
  return [
    ...tier(baseValues, logical, true),
    ...tier(viewValues, physical, false),
  ];
}

function requireObject(value: unknown): void {
  if (
    value !== undefined &&
    (value === null || typeof value !== "object" || Array.isArray(value))
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "View namespace must contain an object",
    );
}

function withoutStorage(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "instances"),
  );
}

function nest(
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  let entries: Record<string, unknown> = {};
  let child = value;
  for (const key of [...path].reverse()) {
    entries = { [key]: child };
    child = entries;
  }
  return entries;
}

function validateView(
  schemas: readonly ConfigurationPropertySchema[],
  value: unknown,
  path: readonly string[],
): void {
  for (const schema of schemas) {
    if (!validateEffectiveConfiguration(schema, value, { path }).valid)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Effective view does not satisfy its logical schema",
      );
  }
}
