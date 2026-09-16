import { compileInternalLayout, deepGet } from "@weaver-conf/config-engine";
import {
  type ScopeInstance,
  WeaverErrorInstance,
  type WriteResult,
} from "@weaver-conf/config-types";
import { createWeaverError } from "../types/errors";
import type { ConfigSnapshot } from "../types/index";
import { activeInspectionLayers } from "./config-inspection-layers";
import {
  snapshotMutationInput,
  snapshotSchemaWriteContext,
  snapshotWriteContext,
} from "./config-mutation-input";
import { createProviderFacades } from "./config-provider-facade";
import type { ConfigServiceController } from "./config-service-controller";
import { validateRegisteredEffectiveConfiguration } from "./config-service-schema-writes";
import type {
  EffectiveValidationContext,
  WeaverConfigService,
} from "./config-service-types";
import { isProtectedConfigPath } from "./protected-config-paths";
import { inspectPublicConfig } from "./public-config-inspection";
import {
  assertRuntimeReadPath,
  assertValidRuntimeRead,
  validateRuntimeEffective,
} from "./schema-read-boundary";
import { assertInventoryContext } from "./scope-inventory";
import { collectAuthoritySnapshot } from "./service-authority-snapshot";

export function createConfigServiceFacade(
  host: ConfigServiceController,
): WeaverConfigService {
  const providers = createProviderFacades(host);
  return {
    get providers() {
      return providers;
    },
    get degradedProviders() {
      host.coordinator.assertApplicationAccess();
      return host.readiness.failedIds();
    },
    get revision() {
      host.coordinator.assertApplicationAccess();
      return host.authority.revision();
    },
    get layout() {
      host.coordinator.assertApplicationAccess();
      const state = host.pipeline.contracts.prepared().configuration;
      const generation =
        state.infrastructure.generations[state.infrastructure.activeGeneration];
      if (!generation)
        throw createWeaverError("SERVER_DEGRADED", "Active layout unavailable");
      return compileInternalLayout(structuredClone(generation.layout));
    },
    async assertScopeMembership(path, signal) {
      host.coordinator.assertApplicationAccess();
      signal?.throwIfAborted();
      host.assertReady();
      if (!host.inventory)
        throw createWeaverError(
          "SERVER_DEGRADED",
          "Scope inventory is not initialized",
        );
      assertInventoryContext(host.inventory, path);
    },
    authoritySnapshot: () =>
      runApplicationOperation(host, () => collectAuthoritySnapshot(host)),
    ...readFacade(host),
    ...mutationFacade(host),
    ...lifecycleFacade(host),
  };
}

function mutationFacade(
  host: ConfigServiceController,
): Pick<
  WeaverConfigService,
  "set" | "remove" | "setMany" | "setRegisteredObject" | "patchRegisteredPath"
> {
  return {
    set: (layer, key, value, options) =>
      prepareApplicationMutation(host, () => {
        const owned = snapshotMutationInput(value);
        const context = snapshotWriteContext(options);
        return () => host.mutations.set(layer, key, owned, context);
      }),
    remove: (layer, key, options) =>
      prepareApplicationMutation(host, () => {
        const context = snapshotWriteContext(options);
        return () => host.mutations.remove(layer, key, context);
      }),
    setMany: (layer, entries, options) =>
      prepareApplicationMutation(host, () => {
        const owned = snapshotMutationInput(entries);
        const context = snapshotWriteContext(options);
        return () => host.mutations.setMany(layer, owned, context);
      }),
    ...registeredMutationFacade(host),
  };
}

function registeredMutationFacade(
  host: ConfigServiceController,
): Pick<WeaverConfigService, "setRegisteredObject" | "patchRegisteredPath"> {
  return {
    setRegisteredObject: (layer, path, value, options) =>
      prepareApplicationMutation(host, () => {
        const owned = snapshotMutationInput(value);
        const context = snapshotSchemaWriteContext(options);
        return () =>
          host.mutations.setRegisteredObject(layer, path, owned, context);
      }),
    patchRegisteredPath: (layer, path, value, options) =>
      prepareApplicationMutation(host, () => {
        const owned = snapshotMutationInput(value);
        const context = snapshotSchemaWriteContext(options);
        return () =>
          host.mutations.patchRegisteredPath(layer, path, owned, context);
      }),
  };
}

async function runApplicationMutation(
  host: ConfigServiceController,
  operation: () => Promise<WriteResult>,
): Promise<WriteResult> {
  try {
    return await runApplicationOperation(host, operation);
  } catch (error) {
    return maintenanceWriteFailure(host, error);
  }
}

async function prepareApplicationMutation(
  host: ConfigServiceController,
  prepare: () => () => Promise<WriteResult>,
): Promise<WriteResult> {
  try {
    const lease = host.batchContext.current();
    if (lease) host.coordinator.assertBatchLease(lease);
    else host.coordinator.assertApplicationAccess();
    return await runApplicationMutation(host, prepare());
  } catch (error) {
    return maintenanceWriteFailure(host, error);
  }
}

function maintenanceWriteFailure(
  host: ConfigServiceController,
  error: unknown,
): WriteResult {
  if (
    !(error instanceof WeaverErrorInstance) ||
    !host.coordinator.isAdmissionFailure(error)
  )
    throw error;
  return {
    success: false,
    error: { code: error.code, message: error.message },
  };
}

function runApplicationOperation<T>(
  host: ConfigServiceController,
  operation: () => Promise<T> | T,
): Promise<T> {
  const lease = host.batchContext.current();
  return lease
    ? host.coordinator.submitBatch(lease, operation)
    : host.coordinator.runApplication(operation);
}

function runApplicationBatch<T>(
  host: ConfigServiceController,
  operation: () => Promise<T>,
): Promise<T> {
  return host.maintenance.batch(operation);
}

function lifecycleFacade(
  host: ConfigServiceController,
): Pick<
  WeaverConfigService,
  | "reloadProvider"
  | "refreshProviders"
  | "onDelta"
  | "batch"
  | "flush"
  | "close"
  | "validateRegisteredEffective"
> {
  return {
    reloadProvider: (id) =>
      runApplicationOperation(host, () =>
        host.reload(
          host.providers.filter((provider) => provider.id === id),
          false,
        ),
      ),
    refreshProviders: () =>
      runApplicationOperation(host, () => host.reload(host.providers, true)),
    onDelta: (handler) => {
      host.coordinator.assertApplicationAccess();
      host.assertReady();
      return host.runtime.onDelta(handler);
    },
    batch: (fn) => runApplicationBatch(host, fn),
    flush: () =>
      runApplicationOperation(host, () => {
        host.assertOpen();
        return host.flush();
      }),
    close: async () => {
      host.coordinator.assertSubmissionAllowed();
      return host.close();
    },
    validateRegisteredEffective: (path, opts) =>
      runApplicationOperation(host, () => validateEffective(host, path, opts)),
  };
}

async function validateEffective(
  host: ConfigServiceController,
  path: string,
  opts: EffectiveValidationContext,
) {
  host.assertReady();
  await host.warmScopeLayers(opts.scopePath);
  const entries = await host.runtime.resolve(opts.scopePath);
  return validateRegisteredEffectiveConfiguration(
    path,
    opts,
    host.options.environment,
    (anchor, environment) =>
      validateRuntimeEffective(host.getService(), entries, anchor, environment),
  );
}
function readFacade(
  host: ConfigServiceController,
): Pick<
  WeaverConfigService,
  "resolveAll" | "get" | "getNamespace" | "inspect"
> {
  return {
    resolveAll: (opts) =>
      runApplicationOperation(host, () => snapshot(host, opts?.scopePath)),
    get: (key, opts) =>
      runApplicationOperation(host, () =>
        resolvedRead(host, key, opts?.scopePath),
      ),
    getNamespace: (prefix, opts) =>
      runApplicationOperation(host, async () => {
        const value = await resolvedRead(host, prefix, opts?.scopePath);
        return value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value))
          : {};
      }),
    inspect: (key) =>
      runApplicationOperation(host, async () => {
        host.assertReady();
        if (!isProtectedConfigPath(key))
          assertRuntimeReadPath(host.getService(), key);
        return structuredClone(
          inspectPublicConfig(key, activeInspectionLayers(host)),
        );
      }),
  };
}
async function resolvedRead(
  host: ConfigServiceController,
  key: string,
  scopePath?: ScopeInstance[],
): Promise<unknown> {
  host.assertReady();
  if (isProtectedConfigPath(key)) return undefined;
  assertRuntimeReadPath(host.getService(), key);
  await host.warmScopeLayers(scopePath);
  const entries = await host.runtime.resolve(scopePath);
  const candidate = checkedRead(host, entries);
  return deepGet(candidate, key);
}
async function snapshot(
  host: ConfigServiceController,
  scopePath?: ScopeInstance[],
): Promise<ConfigSnapshot> {
  host.assertReady();
  await host.warmScopeLayers(scopePath);
  const paths = scopePath?.length ? [scopePath] : snapshotPaths(host);
  for (const path of paths) await host.warmScopeLayers(path);
  const resolved = await host.runtime.resolveSnapshot(paths);
  const entries = checkedRead(host, resolved.base.entries);
  const scopes: Record<string, Record<string, unknown>> = {};
  for (const context of resolved.scopes) {
    scopes[context.layer] = checkedRead(host, context.entries);
  }
  return {
    entries,
    scopes,
    revision: host.authority.revision(),
    timestamp: new Date().toISOString(),
  };
}
function checkedRead(
  host: ConfigServiceController,
  entries: Record<string, unknown>,
) {
  try {
    return assertValidRuntimeRead(host.getService(), entries);
  } catch (error) {
    host.readiness.invalidate("configuration-contracts", String(error));
    throw error;
  }
}
function snapshotPaths(host: ConfigServiceController): ScopeInstance[][] {
  if (!host.inventory)
    throw createWeaverError(
      "SERVER_DEGRADED",
      "Scope inventory is not initialized",
    );
  return Object.values(host.inventory.contexts)
    .filter((context) => context.state === "active")
    .map((context) => context.scopePath);
}
