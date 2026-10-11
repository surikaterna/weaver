import {
  type ConfigurationAuthorityCapability,
  type ConfigurationReader,
  type ConfigurationReaderSelection,
  type ConfigurationServiceIdentity,
  configurationReaderGetOptionsSchema,
  configurationReaderSnapshotSchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import type { createReadCheck } from "./authority/authority-read";
import { requestFor } from "./authority/authorization-requests";
import type { createCapabilityRegistry } from "./authority/capability-registry";
import { validateIdentity } from "./authority/validation-query";
import {
  captureReaderSelection,
  readerLayers,
  readerPath,
} from "./reader-selection";
import { createReaderSubscriptions } from "./reader-subscriptions";
import {
  assertNotDisposed,
  assertReadable,
  type RootState,
} from "./root-state";
import { prepareView, selectedSnapshot } from "./view-snapshots";

interface ReaderExecution {
  readonly state: RootState;
  readonly registry: ReturnType<typeof createCapabilityRegistry>;
  readonly check: ReturnType<typeof createReadCheck>;
  readonly prepare: (
    identity: ConfigurationServiceIdentity,
    guard: () => void,
  ) => Promise<void>;
}

export function createConfigurationReader(
  execution: ReaderExecution,
  token: ConfigurationAuthorityCapability,
  input: ConfigurationReaderSelection,
): ConfigurationReader {
  const selection = captureReaderSelection(
    execution.state,
    execution.registry,
    token,
    input,
  );
  let disposed = false;
  const guard = () => {
    assertNotDisposed(execution.state);
    if (disposed)
      throw createWeaverError("DISPOSED", "Configuration reader is disposed");
    execution.registry.current(token);
    assertReadable(execution.state);
  };
  const query = queryFor(execution, token, selection, guard);
  const subscriptions = createReaderSubscriptions(
    execution.state.events,
    selection,
    subscriptionQuery(query),
  );
  return Object.freeze<ConfigurationReader>({
    get selection() {
      guard();
      return selection;
    },
    get revision() {
      return authorizeSelected(query, []).snapshot.revision;
    },
    prepare: () => prepareReader(execution, token, selection, guard),
    ...readMethods(execution.state, selection, query, guard),
    ...deriveMethods(execution, token, selection, guard),
    onChange(relative, listener, options) {
      guard();
      return subscriptions.subscribe(relative, listener, options);
    },
    dispose() {
      disposed = true;
      subscriptions.clear();
    },
  });
}

function deriveMethods(
  execution: ReaderExecution,
  token: ConfigurationAuthorityCapability,
  selection: ConfigurationReaderSelection,
  guard: () => void,
): Pick<ConfigurationReader, "withScope" | "forView"> {
  return {
    withScope(scopePath) {
      guard();
      return createConfigurationReader(execution, token, {
        ...selection,
        identity: { ...selection.identity, scopePath },
      });
    },
    forView(viewId) {
      guard();
      return createConfigurationReader(execution, token, {
        identity: selection.identity,
        namespace: selection.namespace,
        ...(viewId === undefined ? {} : { viewId }),
      });
    },
  };
}

function queryFor(
  execution: ReaderExecution,
  token: ConfigurationAuthorityCapability,
  selection: ConfigurationReaderSelection,
  guard: () => void,
) {
  return (relative: unknown, operation: "read" | "inspect", layer?: string) => {
    guard();
    const path = readerPath(selection, relative);
    const snapshot = selectedSnapshot(execution.state, selection);
    const layers =
      layer === undefined ? readerLayers(execution.state, selection) : [layer];
    const access = execution.check(
      token,
      requestFor(
        selection.identity,
        selection.namespace,
        path,
        operation,
        layer,
        selection.viewId,
      ),
      layers,
      true,
    );
    guard();
    if (selectedSnapshot(execution.state, selection) !== snapshot)
      throw createWeaverError(
        "FORBIDDEN",
        "Configuration changed during authorization",
      );
    return {
      snapshot,
      path,
      access,
      guard: () => {
        guard();
        if (selectedSnapshot(execution.state, selection) !== snapshot)
          throw createWeaverError(
            "FORBIDDEN",
            "Configuration changed during authorization",
          );
      },
    };
  };
}

type Query = ReturnType<typeof queryFor>;

function subscriptionQuery(query: Query): Query {
  return (relative, operation, layer) => {
    const selected = query(relative, operation, layer);
    if (layer === undefined)
      selected.snapshot.projection.get(selected.path, selected.access);
    else
      selected.snapshot.projection.getAtLayer(
        layer,
        selected.path,
        selected.access,
      );
    selected.guard();
    return selected;
  };
}

function authorizeSelected(query: Query, relative: unknown) {
  const selected = query(relative, "read");
  selected.snapshot.projection.get(selected.path, selected.access);
  selected.guard();
  return selected;
}

function readMethods(
  state: RootState,
  selection: ConfigurationReaderSelection,
  query: Query,
  guard: () => void,
) {
  return {
    get(relative = [], input = {}) {
      // Check the handle before inspecting any caller-owned option descriptors.
      guard();
      const parsed = configurationReaderGetOptionsSchema.safeParse(input);
      if (!parsed.success)
        throw createWeaverError("VALIDATION_ERROR", "Invalid read options");
      const options = parsed.data;
      const { snapshot, path, access } = query(relative, "read", options.layer);
      const value =
        options.layer === undefined
          ? snapshot.projection.get(path, access)
          : snapshot.projection.getAtLayer(options.layer, path, access);
      guard();
      return value === undefined ? options.defaultValue : value;
    },
    snapshot(relative = []) {
      return snapshotValue(selection, query(relative, "read"));
    },
    inspect(relative = []) {
      const { snapshot, path, access } = query(relative, "inspect");
      const inspected = snapshot.projection.inspect(path, access);
      guard();
      return inspected;
    },
    validate(relative = []) {
      return validateReader(state, selection, query, relative);
    },
  } satisfies Pick<
    ConfigurationReader,
    "get" | "snapshot" | "inspect" | "validate"
  >;
}

function snapshotValue(
  selection: ConfigurationReaderSelection,
  { snapshot, path, access, guard }: ReturnType<Query>,
) {
  const value = snapshot.projection.get(path, access);
  guard();
  return configurationReaderSnapshotSchema.parse({
    selection,
    revision: snapshot.revision,
    value:
      value === undefined ? { state: "missing" } : { state: "value", value },
    mode: snapshot.degradedProviders.length ? "degraded" : "live",
    degradedProviders: snapshot.degradedProviders,
  });
}

function validateReader(
  state: RootState,
  selection: ConfigurationReaderSelection,
  query: Query,
  relative: unknown,
) {
  const { snapshot, path } = query(relative, "inspect");
  return validateIdentity(
    state,
    (target, operation) => {
      const suffix = target.slice(
        selection.namespace === "/" ? 1 : selection.namespace.length + 1,
      );
      const checked = query(
        target === selection.namespace ? [] : suffix.split("/"),
        operation,
      );
      const current = checked.snapshot;
      current.projection.authorizeValidation(checked.path, checked.access);
      checked.guard();
      if (current !== snapshot)
        throw createWeaverError(
          "FORBIDDEN",
          "Configuration changed during validation",
        );
      return current;
    },
    path,
    selection.viewId === undefined ? undefined : selection.namespace,
  );
}

async function prepareReader(
  execution: ReaderExecution,
  token: ConfigurationAuthorityCapability,
  selection: ConfigurationReaderSelection,
  guard: () => void,
): Promise<void> {
  const admit = () => {
    guard();
    execution.check(
      token,
      requestFor(
        selection.identity,
        selection.namespace,
        selection.namespace,
        "read",
        undefined,
        selection.viewId,
      ),
      readerLayers(execution.state, selection),
      false,
    );
    guard();
  };
  admit();
  await execution.prepare(selection.identity, admit);
  admit();
  if (selection.viewId !== undefined)
    await prepareView(execution.state, selection, admit);
  admit();
}
