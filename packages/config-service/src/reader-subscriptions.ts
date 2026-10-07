import { deepEqual } from "@weaver-conf/config-engine";
import type { RegisteredReadAccess } from "@weaver-conf/config-registry";
import {
  type ConfigurationNamespace,
  type ConfigurationReaderChange,
  type ConfigurationReaderChangeOptions,
  type ConfigurationReaderSelection,
  configurationReaderChangeOptionsSchema,
  configurationReaderChangeSchema,
  createWeaverError,
  type RelativeConfigurationPath,
  relativeConfigurationPathSchema,
} from "@weaver-conf/config-types";
import type { IdentitySnapshot } from "./identity-snapshots";
import { identityKey } from "./layer-stack";
import { changeReloadBehavior } from "./restart-state";
import type {
  createServiceEvents,
  ReaderChangeSnapshots,
} from "./service-events";

type Query = (
  relative: unknown,
  operation: "read" | "inspect",
  layer?: string,
) => {
  readonly path: ConfigurationNamespace;
  readonly access: RegisteredReadAccess;
  readonly guard: () => void;
  readonly snapshot: IdentitySnapshot;
};

export function createReaderSubscriptions(
  events: ReturnType<typeof createServiceEvents>,
  selection: ConfigurationReaderSelection,
  query: Query,
) {
  const owned = new Set<() => void>();
  return {
    subscribe(
      relative: RelativeConfigurationPath,
      listener: (change: ConfigurationReaderChange) => void,
      input: ConfigurationReaderChangeOptions = {},
    ) {
      const options = configurationReaderChangeOptionsSchema.parse(input);
      const { path } = query(relative, "read", options.layer);
      if (options.layer !== undefined)
        query(relative, "inspect", options.layer);
      if (typeof listener !== "function")
        throw createWeaverError("VALIDATION_ERROR", "Invalid change listener");
      const captured = relativeConfigurationPathSchema.parse(relative);
      let active = true;
      const release = events.subscribe(selection, path, (change) => {
        if (!active) return;
        deliver(change, selection, captured, query, listener, options);
      });
      const unsubscribe = () => {
        if (!active) return;
        active = false;
        release();
        owned.delete(unsubscribe);
      };
      owned.add(unsubscribe);
      return unsubscribe;
    },
    clear() {
      for (const unsubscribe of owned) unsubscribe();
    },
  };
}

function deliver(
  change: ReaderChangeSnapshots,
  selection: ConfigurationReaderSelection,
  relative: RelativeConfigurationPath,
  query: Query,
  listener: (change: ConfigurationReaderChange) => void,
  options: ConfigurationReaderChangeOptions,
): void {
  try {
    const { path, access, guard, snapshot } = query(
      relative,
      "read",
      options.layer,
    );
    if (!sameSelection(change.selection, selection)) return;
    // Aggregate authorization can prune a newly private child without denying
    // its parent. Never project queued values with obsolete captured policy.
    if (
      identityKey(change.previous.identity) !==
        identityKey(selection.identity) ||
      identityKey(change.current.identity) !== identityKey(selection.identity)
    )
      return;
    const event = projectChange(change, selection, relative, query, options, {
      path,
      access,
      snapshot,
      guard,
    });
    if (!event) return;
    guard();
    void Promise.resolve(listener(event)).catch(() => {});
  } catch {
    /* Stale queued deliveries never expose payload or authority errors. */
  }
}

function projectChange(
  change: ReaderChangeSnapshots,
  selection: ConfigurationReaderSelection,
  relative: RelativeConfigurationPath,
  query: Query,
  options: ConfigurationReaderChangeOptions,
  selected: ReturnType<Query>,
): ConfigurationReaderChange | undefined {
  const { path, snapshot } = selected;
  const common = {
    selection,
    path,
    previousRevision: change.previous.revision,
    revision: change.current.revision,
    cause: change.cause,
  };
  if (options.layer !== undefined) {
    query(relative, "read", options.layer);
    query(relative, "inspect", options.layer);
  }
  if (
    change.cause === "schema" ||
    change.previous.registryRevision !== snapshot.registryRevision ||
    change.current.registryRevision !== snapshot.registryRevision
  )
    return configurationReaderChangeSchema.parse({
      ...common,
      kind: "invalidation",
      revision: snapshot.revision,
      reason: change.cause === "schema" ? "schema" : "stale",
    });
  if (options.layer !== undefined)
    return layerChange(change, common, relative, query, options.layer);
  return effectiveChange(change, common, selected.access);
}

type ChangeCommon = Pick<
  ConfigurationReaderChange,
  "selection" | "path" | "previousRevision" | "revision" | "cause"
>;

function layerChange(
  change: ReaderChangeSnapshots,
  common: ChangeCommon,
  relative: RelativeConfigurationPath,
  query: Query,
  layer: string,
): ConfigurationReaderChange | undefined {
  const checked = query(relative, "inspect", layer);
  const read = query(relative, "read", layer);
  const both: RegisteredReadAccess = (evidence) =>
    (evidence.layer === undefined || evidence.layer === layer) &&
    read.access(evidence) &&
    checked.access(evidence);
  const previous = change.previous.projection
    .inspect(common.path, both)
    .contributions.filter((item) => item.layer === layer);
  const current = change.current.projection
    .inspect(common.path, both)
    .contributions.filter((item) => item.layer === layer);
  if (deepEqual(previous, current)) return;
  checked.guard();
  return configurationReaderChangeSchema.parse({
    ...common,
    kind: "layer",
    layer,
    previous,
    current,
  });
}

function effectiveChange(
  change: ReaderChangeSnapshots,
  common: ChangeCommon,
  access: RegisteredReadAccess,
): ConfigurationReaderChange | undefined {
  const { path, selection } = common;
  const previous = change.previous.projection.inspect(path, access).effective;
  const current = change.current.projection.inspect(path, access).effective;
  if (deepEqual(previous, current)) return;
  return configurationReaderChangeSchema.parse({
    ...common,
    kind: "effective",
    previous,
    current,
    reloadBehavior: changeReloadBehavior(
      change.previous,
      change.current,
      path === "/" ? [] : path.split("/").slice(1),
      previous.state === "value" ? previous.value : undefined,
      current.state === "value" ? current.value : undefined,
      selection,
    ),
  });
}

function sameSelection(
  left: ConfigurationReaderSelection,
  right: ConfigurationReaderSelection,
): boolean {
  return (
    identityKey(left.identity) === identityKey(right.identity) &&
    left.namespace === right.namespace &&
    left.viewId === right.viewId
  );
}
