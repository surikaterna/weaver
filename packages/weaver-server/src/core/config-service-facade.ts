import { compileInternalLayout, deepGet } from "@weaver-conf/config-engine";
import type { ScopeInstance } from "@weaver-conf/config-types";
import { createWeaverError } from "../types/errors";
import type { ConfigSnapshot } from "../types/index";
import { activeInspectionLayers } from "./config-inspection-layers";
import {
  snapshotMutationInput,
  snapshotSchemaWriteContext,
  snapshotWriteContext,
} from "./config-mutation-input";
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
  return {
    get providers() {
      return host.providers;
    },
    get degradedProviders() {
      return host.readiness.failedIds();
    },
    get revision() {
      return host.authority.revision();
    },
    get layout() {
      const state = host.pipeline.contracts.prepared().configuration;
      const generation =
        state.infrastructure.generations[state.infrastructure.activeGeneration];
      if (!generation)
        throw createWeaverError("SERVER_DEGRADED", "Active layout unavailable");
      return compileInternalLayout(structuredClone(generation.layout));
    },
    async assertScopeMembership(path, signal) {
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
      host.coordinator.run(() => collectAuthoritySnapshot(host)),
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
    async set(layer, key, value, options) {
      const owned = snapshotMutationInput(value);
      const context = snapshotWriteContext(options);
      return host.coordinator.run(() =>
        host.mutations.set(layer, key, owned, context),
      );
    },
    async remove(layer, key, options) {
      const context = snapshotWriteContext(options);
      return host.coordinator.run(() =>
        host.mutations.remove(layer, key, context),
      );
    },
    async setMany(layer, entries, options) {
      const owned = snapshotMutationInput(entries);
      const context = snapshotWriteContext(options);
      return host.coordinator.run(() =>
        host.mutations.setMany(layer, owned, context),
      );
    },
    ...registeredMutationFacade(host),
  };
}

function registeredMutationFacade(
  host: ConfigServiceController,
): Pick<WeaverConfigService, "setRegisteredObject" | "patchRegisteredPath"> {
  return {
    async setRegisteredObject(layer, path, value, options) {
      const owned = snapshotMutationInput(value);
      const context = snapshotSchemaWriteContext(options);
      return host.coordinator.run(() =>
        host.mutations.setRegisteredObject(layer, path, owned, context),
      );
    },
    async patchRegisteredPath(layer, path, value, options) {
      const owned = snapshotMutationInput(value);
      const context = snapshotSchemaWriteContext(options);
      return host.coordinator.run(() =>
        host.mutations.patchRegisteredPath(layer, path, owned, context),
      );
    },
  };
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
      host.coordinator.run(() =>
        host.reload(
          host.providers.filter((provider) => provider.id === id),
          false,
        ),
      ),
    refreshProviders: () =>
      host.coordinator.run(() => host.reload(host.providers, true)),
    onDelta: (handler) => {
      host.assertReady();
      return host.runtime.onDelta(handler);
    },
    batch: (fn) => host.batch(fn),
    flush: () =>
      host.coordinator.run(() => {
        host.assertOpen();
        return host.flush();
      }),
    close: async () => {
      host.coordinator.assertNotRunning();
      return host.close();
    },
    validateRegisteredEffective: (path, opts) =>
      host.coordinator.run(() => validateEffective(host, path, opts)),
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
      host.coordinator.run(() => snapshot(host, opts?.scopePath)),
    get: (key, opts) =>
      host.coordinator.run(() => resolvedRead(host, key, opts?.scopePath)),
    getNamespace: (prefix, opts) =>
      host.coordinator.run(async () => {
        const value = await resolvedRead(host, prefix, opts?.scopePath);
        return value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value))
          : {};
      }),
    inspect: (key) =>
      host.coordinator.run(async () => {
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
