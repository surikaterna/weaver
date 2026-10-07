import {
  type ConfigurationSnapshot,
  inspectResolvedPath,
  parseCanonicalConfigPath,
  resolveConfigurationSnapshot,
} from "@weaver-conf/config-engine";
import type {
  ConfigurationInspectionValue,
  ConfigurationLayerContribution,
  ConfigurationNamespace,
  HydratedConfigurationInspection,
} from "@weaver-conf/config-types";
import {
  canonicalConfigurationPathSchema,
  configurationNamespaceSchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import { captureViewSources, layerAccess } from "./registered-read-access";
import {
  captureReadAnchors,
  createReadContexts,
  type ReadContext,
} from "./registered-read-contexts";
import type {
  RegisteredReadAccess,
  RegisteredReadViewSource,
} from "./registered-read-contracts";
import {
  type RegisteredReadProjection,
  type RegisteredReadProjectionContext,
  registeredReadProjectionContextSchema,
} from "./registered-read-contracts";
import {
  createReadPolicy,
  createReadSourceClassifier,
  recordValue,
} from "./registered-read-policy";
import type { RegistryProjectionReader } from "./registry-contracts";

type Contexts = ReturnType<typeof createReadContexts>;
type Policy = ReturnType<typeof createReadPolicy>;
interface LayerView {
  readonly contexts: Contexts;
  readonly policy: Policy;
}
interface ReadRevision {
  readonly source: RegisteredReadViewSource | undefined;
  readonly snapshot: ConfigurationSnapshot;
  readonly context: RegisteredReadProjectionContext;
  readonly effective: LayerView;
  readonly raws: ReadonlyMap<object, LayerView>;
  readonly view: (entries: Readonly<Record<string, unknown>>) => LayerView;
}

export function createRegisteredReadProjection(
  reader: RegistryProjectionReader,
  snapshot: ConfigurationSnapshot,
  context: RegisteredReadProjectionContext,
  source?: RegisteredReadViewSource,
): RegisteredReadProjection {
  inspectResolvedPath(snapshot, []);
  const parsed = registeredReadProjectionContextSchema.safeParse(context);
  if (!parsed.success)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid registered read context",
    );
  const revision = createRevision(reader, snapshot, parsed.data, source);
  // Capture addressed evidence now, not against a future registry on first use.
  // Principal decisions are never retained in either metadata traversal mode.
  const addressed = createRevision(reader, snapshot, parsed.data, source, true);
  const forAccess = (access?: RegisteredReadAccess) =>
    access ? addressed : revision;
  return projectionMethods(revision, forAccess);
}

function projectionMethods(
  revision: ReadRevision,
  forAccess: (access?: RegisteredReadAccess) => ReadRevision,
): RegisteredReadProjection {
  const publicEntries = recordValue(
    revision.effective.policy.projected(revision.effective.contexts.root),
  );
  return Object.freeze({
    authorizeValidation: (
      path: ConfigurationNamespace,
      access?: RegisteredReadAccess,
    ) =>
      forAccess(access).effective.policy.authorizeValidation(
        forAccess(access).effective.contexts.at(requestPath(path).segments),
        access,
      ),
    entries: (access?: RegisteredReadAccess) =>
      access
        ? recordValue(
            forAccess(access).effective.policy.projected(
              forAccess(access).effective.contexts.root,
              access,
            ),
          )
        : publicEntries,
    get: (path: ConfigurationNamespace, access?: RegisteredReadAccess) =>
      forAccess(access).effective.policy.get(
        forAccess(access).effective.contexts.at(requestPath(path).segments),
        access,
      ),
    getNamespace: (
      prefix: ConfigurationNamespace,
      access?: RegisteredReadAccess,
    ) =>
      recordValue(
        forAccess(access).effective.policy.get(
          forAccess(access).effective.contexts.at(requestPath(prefix).segments),
          access,
        ),
      ),
    getAtLayer: (
      layer: string,
      path: ConfigurationNamespace,
      access?: RegisteredReadAccess,
    ) => readLayer(layer, path, forAccess(access), access),
    inspect: (path: ConfigurationNamespace, access?: RegisteredReadAccess) =>
      inspectPath(path, forAccess(access), access),
  });
}

function createRevision(
  reader: RegistryProjectionReader,
  snapshot: ConfigurationSnapshot,
  context: RegisteredReadProjectionContext,
  source?: RegisteredReadViewSource,
  addressed = false,
): ReadRevision {
  const view = createViewFactory(reader, snapshot, context, source, addressed);
  const raws = new Map<object, LayerView>();
  for (const layer of snapshot.layers) raws.set(layer, view(layer.entries));
  return Object.freeze({
    snapshot,
    source,
    context,
    effective: view(snapshot.entries),
    raws,
    view,
  });
}

function createViewFactory(
  reader: RegistryProjectionReader,
  snapshot: ConfigurationSnapshot,
  context: RegisteredReadProjectionContext,
  source: RegisteredReadViewSource | undefined,
  addressed: boolean,
) {
  const anchors = captureReadAnchors(reader, context.identity.environment);
  const sources = snapshot.layers.map((layer) => layer.entries);
  // Source proof is a separate iterative graph, never a recursive read-policy lookup.
  const sourceEffective = createReadContexts(anchors, snapshot.entries);
  const rawContexts = snapshot.layers.map((layer) =>
    createReadContexts(anchors, layer.entries),
  );
  const physical = captureViewSources(
    reader,
    context.identity.environment,
    source,
  );
  const aliases = rawContexts.map((contexts) =>
    createReadSourceClassifier(contexts, recordValue(contexts.root.candidate)),
  );
  return (entries: Readonly<Record<string, unknown>>): LayerView => {
    const contexts = createReadContexts(
      anchors,
      entries,
      sources,
      [],
      addressed,
    );
    return {
      contexts,
      policy: createReadPolicy(
        contexts,
        sourceEffective,
        snapshot.entries,
        aliases,
        (current) => [
          ...rawContexts.map((raw) => raw.at(current.path)),
          ...physical(current),
        ],
      ),
    };
  };
}

function inspectPath(
  path: ConfigurationNamespace,
  revision: ReadRevision,
  access?: RegisteredReadAccess,
): HydratedConfigurationInspection {
  const canonical = requestPath(path);
  const { contexts, policy } = revision.effective;
  const current = contexts.at(canonical.segments);
  policy.requireDeclared(current);
  const trace = inspectResolvedPath(revision.snapshot, canonical.segments);
  const effective = inspectionValue(current, policy, access);
  return Object.freeze({
    path: canonical.path,
    identity: revision.context.identity,
    revision: revision.context.revision,
    ...(revision.source
      ? { namespace: revision.source.namespace, viewId: revision.source.viewId }
      : {}),
    effective,
    ...(effective.state === "value" && trace.effectiveLayer !== undefined
      ? { effectiveLayer: trace.effectiveLayer }
      : {}),
    ...(effective.state === "value" &&
    trace.effectiveSourcePath &&
    revision.source
      ? {
          effectiveSource:
            trace.effectiveSourcePath.length ===
            parseCanonicalConfigPath(revision.source.namespace).segments.length
              ? ("base" as const)
              : ("view" as const),
        }
      : {}),
    contributions: contributions(canonical.segments, revision, access),
  });
}

function contributions(
  segments: readonly string[],
  revision: ReadRevision,
  access?: RegisteredReadAccess,
): readonly ConfigurationLayerContribution[] {
  const result: ConfigurationLayerContribution[] = [];
  for (const layer of revision.snapshot.layers) {
    const view = revision.raws.get(layer);
    if (!view)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Missing registered layer context",
      );
    const value = inspectionValue(
      view.contexts.at(segments),
      view.policy,
      layerAccess(access, layer.layer),
    );
    result.push(
      Object.freeze({
        layer: layer.layer,
        providerId: layer.providerId,
        ...(layer.sourcePath && revision.source
          ? {
              source:
                layer.sourcePath.length ===
                parseCanonicalConfigPath(revision.source.namespace).segments
                  .length
                  ? ("base" as const)
                  : ("view" as const),
              sourcePath: canonicalConfigurationPathSchema.parse(
                `/${[...layer.sourcePath, ...segments.slice(parseCanonicalConfigPath(revision.source.namespace).segments.length)].join("/")}`,
              ),
            }
          : {}),
        ...value,
      }),
    );
  }
  return Object.freeze(result);
}

function requestPath(path: ConfigurationNamespace) {
  if (typeof path !== "string")
    throw createWeaverError("VALIDATION_ERROR", "Invalid configuration path");
  const parsed = configurationNamespaceSchema.safeParse(path);
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid configuration path");
  return { ...parseCanonicalConfigPath(parsed.data), path: parsed.data };
}

function inspectionValue(
  context: ReadContext,
  policy: Policy,
  access?: RegisteredReadAccess,
): ConfigurationInspectionValue {
  if (!context.declared || policy.denied(context, access))
    return Object.freeze({ state: "redacted" });
  const value = policy.projected(context, access);
  if (value === undefined && context.candidate !== undefined)
    return Object.freeze({ state: "redacted" });
  return value === undefined
    ? Object.freeze({ state: "missing" })
    : Object.freeze({ state: "value", value });
}

function readLayer(
  layer: string,
  path: ConfigurationNamespace,
  revision: ReadRevision,
  access?: RegisteredReadAccess,
): unknown {
  const canonical = requestPath(path);
  const { contexts, policy } = revision.effective;
  const current = contexts.at(canonical.segments);
  policy.requireDeclared(current);
  if (policy.denied(current, access))
    throw createWeaverError(
      "FORBIDDEN",
      "Configuration path is not publicly readable",
    );
  if (typeof layer !== "string")
    throw createWeaverError("VALIDATION_ERROR", "Invalid layer name");
  const layers: ConfigurationSnapshot["layers"][number][] = [];
  const ranks = new Set<number>();
  for (const candidate of revision.snapshot.layers) {
    if (candidate.layer === layer) {
      layers.push(candidate);
      ranks.add(candidate.rank);
    }
  }
  if (!layers.length) return undefined;
  // Multiple providers at a logical layer still merge through the same engine.
  const raw = resolveConfigurationSnapshot({
    layers,
    configuredRanks: [...ranks],
    ceilings: [],
  });
  const local = revision.view(raw.entries);
  return local.policy.get(
    local.contexts.at(canonical.segments),
    layerAccess(access, layer),
  );
}
