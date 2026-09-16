import { deepEqual, deepGet } from "@weaver-conf/config-engine";
import { createWeaverError, type WriteResult } from "@weaver-conf/config-types";
import {
  type ApplicationControlTransaction,
  type ManagedApplicationControlTransaction,
  runApplicationControlTransaction,
} from "./config-application-transaction";
import {
  snapshotMutationInput,
  snapshotWriteContext,
} from "./config-mutation-input";
import type { ConfigServiceController } from "./config-service-controller";
import { hostForControl } from "./config-service-host";
import type { WeaverConfigService, WriteContext } from "./config-service-types";

export {
  runMaintenanceOperation,
  suspendControlApplication,
} from "./config-maintenance-admission";
export { hostForControl } from "./config-service-host";
export {
  applicationAdmission,
  applicationConfigurationAvailability,
  applicationProjection,
  assertApplicationAdmission,
  controlProjection,
  schemaRegistryTransactionMode,
} from "./config-service-projection";

type Family = "catalog" | "scope" | "bootstrap" | "maintenance";
interface ControlTransaction extends ApplicationControlTransaction {
  readonly revision: string;
  readonly read: () => unknown;
  readonly write: (
    key: string,
    value: unknown,
    options?: WriteContext,
  ) => Promise<WriteResult>;
}
const permissions = new WeakMap<
  WriteContext,
  {
    family: Family;
    key: string;
    transition?: {
      readonly prepared: ReturnType<
        ConfigServiceController["pipeline"]["contracts"]["prepare"]
      >;
      readonly operationId: string;
    };
    operationId?: string;
  }
>();
const roots = {
  catalog: "_weaver.catalog.registrations.",
  scope: "_weaver.scopeInventory",
  bootstrap: "_weaver",
  maintenance: "_weaver.upgrades.",
};

export function internalPermission(
  options: WriteContext | undefined,
  key?: string,
): boolean {
  const permission = options && permissions.get(options);
  return !!permission && (key === undefined || permission.key === key);
}

const hostFor = hostForControl;

export function setInternalPermission(
  context: WriteContext,
  permission: NonNullable<ReturnType<typeof permissions.get>>,
): void {
  permissions.set(context, permission);
}

export function clearInternalPermission(context: WriteContext): void {
  permissions.delete(context);
}

/** Internal owners receive a family-restricted operation, not a public write option. */
export function controlTransaction<T>(
  service: WeaverConfigService,
  family: Family,
  operation: (transaction: ControlTransaction) => Promise<T>,
): Promise<T> {
  const host = hostFor(service);
  return host.coordinator.runControl(async () => {
    host.assertReady(true);
    const root = roots[family].replace(/\.$/, "");
    let active = true;
    const pending = new Set<Promise<WriteResult>>();
    const write = async (
      key: string,
      value: unknown,
      options?: WriteContext,
    ) => {
      assertControlAccess(host, active);
      if (!active || pending.size)
        return Promise.reject(
          createWeaverError(
            "FORBIDDEN",
            "Control operation is expired or already writing",
          ),
        );
      const result = writeControl(host, family, key, value, options);
      pending.add(result);
      void result.then(
        () => pending.delete(result),
        () => pending.delete(result),
      );
      return result;
    };
    try {
      return await operation({
        revision: host.authority.revision(),
        read: () => readControl(host, root, active),
        write,
      });
    } finally {
      active = false;
      await Promise.allSettled(pending);
    }
  });
}

export function applicationControlTransaction<T>(
  service: WeaverConfigService,
  family: "catalog" | "scope",
  operation: (transaction: ApplicationControlTransaction) => Promise<T>,
): Promise<T> {
  const host = hostFor(service);
  return runApplicationControlTransaction(
    host,
    () => createApplicationTransaction(host, family),
    operation,
  );
}

function createApplicationTransaction(
  host: ConfigServiceController,
  family: "catalog" | "scope",
): ManagedApplicationControlTransaction {
  host.assertReady();
  const root = roots[family].replace(/\.$/, "");
  let active = true;
  const pending = new Set<Promise<WriteResult>>();
  const write = (key: string, value: unknown, options?: WriteContext) => {
    assertControlAccess(host, active);
    if (pending.size)
      return Promise.reject(
        createWeaverError(
          "FORBIDDEN",
          "Control transaction is already writing",
        ),
      );
    const result = writeControl(host, family, key, value, options);
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result),
    );
    return result;
  };
  return {
    transaction: Object.freeze({
      revision: host.authority.revision(),
      read: () => readControl(host, root, active),
      write,
    }),
    close: async () => {
      active = false;
      await Promise.allSettled(pending);
    },
  };
}

function assertControlAccess(
  host: ConfigServiceController,
  active: boolean,
): void {
  if (!active)
    throw createWeaverError("FORBIDDEN", "Control operation is expired");
  host.assertReady(true);
}

function readControl(
  host: ConfigServiceController,
  root: string,
  active: boolean,
): unknown {
  assertControlAccess(host, active);
  return structuredClone(
    deepGet(host.layerData.get(host.pipeline.controlProvider.id) ?? {}, root),
  );
}

function allowedControlPath(
  host: ConfigServiceController,
  family: Family,
  key: string,
): boolean {
  const root = roots[family];
  if (family === "bootstrap")
    return (
      !host.applicationActive &&
      host.options.serviceMode === "control" &&
      (key === root ||
        key === "_weaver.format" ||
        key === "_weaver.infrastructure.activeGeneration" ||
        /^_weaver\.infrastructure\.generations\.[A-Za-z0-9_-]+$/.test(key))
    );
  if (
    (family === "catalog" || family === "scope") &&
    !host.applicationActive &&
    host.pipeline.contracts.prepared().configuration.format.initialization ===
      "initialized"
  )
    return false;
  if (family === "scope") return key === root;
  if (family === "maintenance")
    return (
      !host.applicationActive &&
      (key === "_weaver" ||
        /^_weaver\.upgrades\.(plans|journal)\.[a-f0-9-]+$/.test(key))
    );
  return key.startsWith(root) && !key.slice(root.length).includes(".");
}

async function writeControl(
  host: ConfigServiceController,
  family: Family,
  key: string,
  value: unknown,
  options?: WriteContext & { operationId?: string },
): Promise<WriteResult> {
  const ownedValue = snapshotMutationInput(value);
  const context = snapshotWriteContext(options) ?? {};
  if (!allowedControlPath(host, family, key))
    throw createWeaverError(
      "FORBIDDEN",
      "Control capability does not grant this path",
    );
  if (family === "bootstrap") assertBootstrapOperation(host, key, ownedValue);
  if (family === "catalog" && context.expectedRevision === undefined) {
    const previous = deepGet(
      host.layerData.get(host.pipeline.controlProvider.id) ?? {},
      key,
    );
    if (previous !== undefined && !deepEqual(previous, ownedValue))
      return {
        success: false,
        error: {
          code: "REVISION_CONFLICT",
          message: "Replacing a registration requires its current revision",
        },
      };
  }
  if (!host.pipeline.controlProvider.writable)
    throw createWeaverError("FORBIDDEN", "Control store is read-only");
  permissions.set(context, {
    family,
    key,
    ...(options?.operationId ? { operationId: options.operationId } : {}),
  });
  try {
    return await host.mutations.set(
      host.pipeline.controlProvider.layer,
      key,
      ownedValue,
      context,
    );
  } finally {
    permissions.delete(context);
  }
}

function assertBootstrapOperation(
  host: ConfigServiceController,
  key: string,
  value: unknown,
): void {
  const entries = host.layerData.get(host.pipeline.controlProvider.id) ?? {};
  if (key === "_weaver") {
    if (entries._weaver !== undefined) {
      assertActivationRoot(host, value);
      return;
    }
    const state = host.pipeline.contracts.prepare(value).configuration;
    if (
      state.format.initialization === "initialized" ||
      state.scopeInventory.revision !== "0" ||
      Object.keys(state.catalog.registrations).length ||
      Object.keys(state.scopeInventory.contexts).length ||
      Object.keys(state.upgrades.plans).length ||
      Object.keys(state.upgrades.journal).length
    )
      throw createWeaverError(
        "FORBIDDEN",
        "Bootstrap grants only format/infrastructure initialization, not other families",
      );
  }
  const current = deepGet(entries, key);
  if (
    key === "_weaver.format" &&
    host.pipeline.contracts.prepared().configuration.format.initialization ===
      "initialized" &&
    !deepEqual(current, value)
  )
    throw createWeaverError("FORBIDDEN", "Initialized format cannot be reset");
  if (
    key.startsWith("_weaver.infrastructure.generations.") &&
    current !== undefined &&
    !deepEqual(current, value)
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Infrastructure generations are immutable",
    );
}

function assertActivationRoot(
  host: ConfigServiceController,
  value: unknown,
): void {
  const previous = host.pipeline.contracts.prepared().configuration;
  const next = host.pipeline.contracts.prepare(value).configuration;
  const permitted = {
    ...previous,
    format: { ...previous.format, initialization: "initialized" },
    infrastructure: {
      ...previous.infrastructure,
      activeGeneration: next.infrastructure.activeGeneration,
    },
  };
  if (!deepEqual(permitted, next))
    throw createWeaverError(
      "FORBIDDEN",
      "Activation may change only the active pointer and initialization state",
    );
}

export async function validateControlCandidate(
  service: WeaverConfigService,
  id: string,
  generation: import("@weaver-conf/config-types").InternalInfrastructureGeneration,
  expectedRevision: string,
): Promise<void> {
  const host = hostFor(service);
  await host.coordinator.runControl(async () => {
    host.assertReady(true);
    if (host.authority.revision() !== expectedRevision)
      throw createWeaverError(
        "REVISION_CONFLICT",
        "Infrastructure precondition changed",
      );
    const state = host.pipeline.contracts.prepared().configuration;
    const prepared = host.pipeline.contracts.prepare({
      ...state,
      infrastructure: {
        activeGeneration: id,
        generations: { ...state.infrastructure.generations, [id]: generation },
      },
    });
    await host.pipeline.validate(
      { base: host.layerData, scoped: host.dynamicScopeEntries },
      prepared,
    );
  });
}

export function activateControlApplication(service: WeaverConfigService) {
  const host = hostFor(service);
  return host.coordinator.runControl(async () => {
    host.pipeline.assertInitialized();
    for (const context of Object.values(
      host.pipeline.contracts.prepared().configuration.scopeInventory.contexts,
    ))
      if (context.state === "active")
        await host.warmScopeLayers(context.scopePath);
    await host.pipeline.validate({
      base: host.layerData,
      scoped: host.dynamicScopeEntries,
    });
    host.openApplication();
    return service;
  });
}

export function transitionPermission(options?: WriteContext) {
  return options && permissions.get(options)?.transition;
}

export function internalOperationId(
  options?: WriteContext,
): string | undefined {
  const permission = options && permissions.get(options);
  return permission?.transition?.operationId ?? permission?.operationId;
}
