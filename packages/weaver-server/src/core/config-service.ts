import { runIndependentCleanup } from "@weaver-conf/config-engine";
import { createWeaverError } from "@weaver-conf/config-types";
import { consumePinnedRecoveryContext } from "../bootstrap/pinned-recovery-open";
import { ConfigAuthority } from "./config-authority";
import { ConfigServiceController } from "./config-service-controller";
import { createConfigServiceFacade } from "./config-service-facade";
import { bindControlHost } from "./config-service-host";
import { bindConfigServiceLifecycle } from "./config-service-lifecycle";
import type {
  WeaverConfigService,
  WeaverConfigServiceOptions,
} from "./config-service-types";
import { bindPinnedRecoveryContext } from "./pinned-recovery-context";
import { bindRuntimeResolutionContexts } from "./runtime-resolution-contexts";
import {
  bindSchemaReadRegistry,
  registerSchemaReadHost,
} from "./schema-read-boundary";
import { registerSchemaBoundaryHost } from "./schema-write-boundary";
import {
  scopeInventoryDigest,
  validateScopeInventory,
} from "./scope-inventory";
import { bindUpgradePlanningHost } from "./upgrade-planning-snapshot";

export type {
  EffectiveValidationContext,
  SchemaWriteContext,
  Unsubscribe,
  WeaverConfigService,
  WeaverConfigServiceOptions,
  WriteContext,
} from "./config-service-types";

export async function createWeaverConfigService(
  options: WeaverConfigServiceOptions,
): Promise<WeaverConfigService> {
  return createConfigService(options);
}

export async function createPinnedWeaverConfigService(
  options: WeaverConfigServiceOptions,
  pinnedRecovery: unknown,
): Promise<WeaverConfigService> {
  const configuration = await consumePinnedRecoveryContext(
    pinnedRecovery,
    options.providers,
  );
  return createConfigService(options, configuration);
}

async function createConfigService(
  options: WeaverConfigServiceOptions,
  pinnedRecovery?: import("@weaver-conf/config-types").InternalConfiguration,
): Promise<WeaverConfigService> {
  const providers = Object.freeze([...options.providers]);
  const inventory =
    options.scopeInventory === undefined
      ? undefined
      : validateScopeInventory(options.scopeInventory);
  if (
    options.requireDurableAuthority &&
    !inventory &&
    options.serviceMode !== "control"
  )
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Durable authority requires a complete scope inventory, including an explicitly empty one",
    );
  const authority = new ConfigAuthority(
    options.infrastructureId ?? options.environment,
    inventory?.revision ?? "0",
    inventory ? scopeInventoryDigest(inventory) : "unknown",
  );
  await authority.acquire(
    providers,
    options.requireDurableAuthority ?? false,
    inventory,
  );
  const host = new ConfigServiceController(
    Object.freeze({
      ...options,
      providers: [...providers],
      ...(inventory ? { scopeInventory: inventory } : {}),
    }),
    providers,
    authority,
    inventory,
  );
  const service = createConfigServiceFacade(host);
  host.bind(service);
  if (pinnedRecovery) bindPinnedRecoveryContext(host, pinnedRecovery);
  bindService(host, service);
  await initializeService(host, authority);
  return service;
}

async function initializeService(
  host: ConfigServiceController,
  authority: ConfigAuthority,
): Promise<void> {
  try {
    await host.initialize();
  } catch (error) {
    await runIndependentCleanup(
      [
        { name: "provider owners", run: () => authority.close() },
        { name: "runtime", run: () => host.runtime.dispose() },
      ],
      error,
    );
  }
}

function bindService(
  host: ConfigServiceController,
  service: WeaverConfigService,
): void {
  bindControlHost(service, host);
  bindConfigServiceLifecycle(service, host.coordinator, () =>
    host.authority.revision(),
  );
  bindUpgradePlanningHost(service, host);
  registerSchemaBoundaryHost(
    service,
    host.options.environment,
    (path, environment) =>
      host.pipeline
        .anchors(environment)
        .filter(
          (anchor) =>
            path === anchor.path ||
            path.startsWith(`${anchor.path}/`) ||
            anchor.path.startsWith(`${path}/`),
        ),
  );
  bindSchemaReadRegistry(service, (environment) =>
    host.pipeline.anchors(environment),
  );
  bindRuntimeResolutionContexts(service, host.runtime);
  registerSchemaReadHost(service, host.options.environment, (path) =>
    host.publishRegistration(path),
  );
}
