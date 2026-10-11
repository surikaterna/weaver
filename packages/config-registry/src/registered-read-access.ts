import {
  inspectResolvedPath,
  parseCanonicalConfigPath,
} from "@weaver-conf/config-engine";
import type { ReadContext } from "./registered-read-contexts";
import {
  captureReadAnchors,
  createReadContexts,
} from "./registered-read-contexts";
import type {
  RegisteredReadAccess,
  RegisteredReadViewSource,
} from "./registered-read-contracts";
import {
  createReadPolicy,
  createReadSourceClassifier,
} from "./registered-read-policy";
import type { RegistryProjectionReader } from "./registry-contracts";

export function captureViewSources(
  reader: RegistryProjectionReader,
  environment: string,
  source?: RegisteredReadViewSource,
) {
  if (!source) return () => [];
  inspectResolvedPath(source.snapshot, []);
  const namespace = parseCanonicalConfigPath(source.namespace).segments;
  const storage = [...namespace, "instances", source.viewId];
  const anchors = captureReadAnchors(reader, environment);
  const entries = [
    source.snapshot.entries,
    ...source.snapshot.layers.map((layer) => layer.entries),
  ];
  const effective = createReadContexts(
    anchors,
    source.snapshot.entries,
    entries.slice(1),
    storage,
  );
  const raws = entries
    .slice(1)
    .map((entry) => createReadContexts(anchors, entry, [], storage));
  const contexts = [effective, ...raws];
  const aliases = raws.map((context, index) =>
    createReadSourceClassifier(context, entries[index + 1] ?? {}),
  );
  const views = contexts.map((context) => ({
    context,
    policy: createReadPolicy(
      context,
      effective,
      source.snapshot.entries,
      aliases,
    ),
  }));
  return (logical: ReadContext): readonly ReadContext[] => {
    if (logical.path.length < namespace.length) return [];
    const path = [...storage, ...logical.path.slice(namespace.length)];
    return views.map((view, index) => physicalSource(view, path, index === 0));
  };
}

function physicalSource(
  view: {
    readonly context: ReturnType<typeof createReadContexts>;
    readonly policy: ReturnType<typeof createReadPolicy>;
  },
  path: readonly string[],
  effective: boolean,
): ReadContext {
  const physical = view.context.at(path);
  const hardForbidden =
    effective &&
    (!physical.declared || view.policy.validationDenied(physical, () => true));
  return hardForbidden
    ? Object.freeze({ ...physical, hardForbidden })
    : physical;
}

export function layerAccess(
  access: RegisteredReadAccess | undefined,
  layer: string,
): RegisteredReadAccess | undefined {
  return access
    ? (evidence) => access(Object.freeze({ ...evidence, layer }))
    : undefined;
}
