import {
  type ConfigurationSnapshot,
  inspectResolvedPath,
  parseCanonicalConfigPath,
  resolveConfigurationSnapshot,
} from "@weaver-conf/config-engine";
import type {
  CanonicalConfigurationPath,
  ConfigurationInspectionValue,
  ConfigurationLayerContribution,
  HydratedConfigurationInspection,
} from "@weaver-conf/config-types";
import {
  canonicalConfigurationPathSchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import {
  captureReadAnchors,
  createReadContexts,
  type ReadContext,
} from "./registered-read-contexts";
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
import type { CanonicalSchemaRegistryReader } from "./registry-contracts";

type Contexts = ReturnType<typeof createReadContexts>;
type Policy = ReturnType<typeof createReadPolicy>;
interface LayerView {
  readonly contexts: Contexts;
  readonly policy: Policy;
}
interface ReadRevision {
  readonly snapshot: ConfigurationSnapshot;
  readonly context: RegisteredReadProjectionContext;
  readonly effective: LayerView;
  readonly raws: ReadonlyMap<object, LayerView>;
  readonly view: (entries: Readonly<Record<string, unknown>>) => LayerView;
}

export function createRegisteredReadProjection(
  reader: CanonicalSchemaRegistryReader,
  snapshot: ConfigurationSnapshot,
  context: RegisteredReadProjectionContext,
): RegisteredReadProjection {
  inspectResolvedPath(snapshot, []);
  const parsed = registeredReadProjectionContextSchema.safeParse(context);
  if (!parsed.success)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid registered read context",
    );
  const revision = createRevision(reader, snapshot, parsed.data);
  const { contexts, policy } = revision.effective;
  const publicEntries = recordValue(policy.projected(contexts.root));
  return Object.freeze({
    entries: () => publicEntries,
    get: (path: CanonicalConfigurationPath) =>
      policy.get(contexts.at(requestPath(path).segments)),
    getNamespace: (prefix: CanonicalConfigurationPath) =>
      recordValue(policy.get(contexts.at(requestPath(prefix).segments))),
    getAtLayer: (layer: string, path: CanonicalConfigurationPath) =>
      readLayer(layer, path, revision),
    inspect: (path: CanonicalConfigurationPath) => inspectPath(path, revision),
  });
}

function createRevision(
  reader: CanonicalSchemaRegistryReader,
  snapshot: ConfigurationSnapshot,
  context: RegisteredReadProjectionContext,
): ReadRevision {
  const anchors = captureReadAnchors(reader, context.identity.environment);
  const sources = snapshot.layers.map((layer) => layer.entries);
  const effective = createReadContexts(anchors, snapshot.entries, sources);
  // Source proof is a separate iterative graph, never a recursive read-policy lookup.
  const sourceEffective = createReadContexts(anchors, snapshot.entries);
  const rawContexts = snapshot.layers.map((layer) =>
    createReadContexts(anchors, layer.entries),
  );
  const aliases = rawContexts.map((contexts) =>
    createReadSourceClassifier(contexts, recordValue(contexts.root.candidate)),
  );
  function view(entries: Readonly<Record<string, unknown>>): LayerView {
    const contexts =
      entries === snapshot.entries
        ? effective
        : createReadContexts(anchors, entries, sources);
    return {
      contexts,
      policy: createReadPolicy(
        contexts,
        sourceEffective,
        snapshot.entries,
        aliases,
      ),
    };
  }
  const raws = new Map<object, LayerView>();
  for (const layer of snapshot.layers) raws.set(layer, view(layer.entries));
  return Object.freeze({
    snapshot,
    context,
    effective: view(snapshot.entries),
    raws,
    view,
  });
}

function inspectPath(
  path: CanonicalConfigurationPath,
  revision: ReadRevision,
): HydratedConfigurationInspection {
  const canonical = requestPath(path);
  const { contexts, policy } = revision.effective;
  const current = contexts.at(canonical.segments);
  policy.requireDeclared(current);
  const trace = inspectResolvedPath(revision.snapshot, canonical.segments);
  const effective = inspectionValue(current, policy);
  return Object.freeze({
    path: canonical.path,
    identity: revision.context.identity,
    revision: revision.context.revision,
    effective,
    ...(effective.state === "value" && trace.effectiveLayer !== undefined
      ? { effectiveLayer: trace.effectiveLayer }
      : {}),
    contributions: contributions(canonical.segments, revision),
  });
}

function contributions(
  segments: readonly string[],
  revision: ReadRevision,
): readonly ConfigurationLayerContribution[] {
  const result: ConfigurationLayerContribution[] = [];
  for (const layer of revision.snapshot.layers) {
    const view = revision.raws.get(layer);
    if (!view)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Missing registered layer context",
      );
    const value = inspectionValue(view.contexts.at(segments), view.policy);
    result.push(
      Object.freeze({
        layer: layer.layer,
        providerId: layer.providerId,
        ...value,
      }),
    );
  }
  return Object.freeze(result);
}

function requestPath(path: CanonicalConfigurationPath) {
  if (typeof path !== "string")
    throw createWeaverError("VALIDATION_ERROR", "Invalid configuration path");
  const parsed = canonicalConfigurationPathSchema.safeParse(path);
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid configuration path");
  return { ...parseCanonicalConfigPath(parsed.data), path: parsed.data };
}

function inspectionValue(
  context: ReadContext,
  policy: Policy,
): ConfigurationInspectionValue {
  if (!context.declared || policy.denied(context))
    return Object.freeze({ state: "redacted" });
  const value = policy.projected(context);
  return value === undefined
    ? Object.freeze({ state: "missing" })
    : Object.freeze({ state: "value", value });
}

function readLayer(
  layer: string,
  path: CanonicalConfigurationPath,
  revision: ReadRevision,
): unknown {
  const canonical = requestPath(path);
  const { contexts, policy } = revision.effective;
  const current = contexts.at(canonical.segments);
  policy.requireDeclared(current);
  if (policy.denied(current))
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
  return local.policy.get(local.contexts.at(canonical.segments));
}
