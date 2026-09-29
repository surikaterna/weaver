import type { WriteResult } from "@weaver-conf/config-types";
import type { WeaverConfigService, WriteContext } from "./config-service-types";

interface InternalConfigAccess {
  readonly environment: string;
  readonly hasPersistedRegistry: () => boolean;
  readonly readRegistry: (layer: string, key: string) => Promise<unknown>;
  readonly read: (key: string) => Promise<unknown>;
  readonly write: (
    layer: string,
    key: string,
    value: unknown,
    options?: WriteContext,
  ) => Promise<WriteResult>;
  readonly remove: (
    layer: string,
    key: string,
    options?: WriteContext,
  ) => Promise<WriteResult>;
}

export async function readInternalConfig(
  configService: WeaverConfigService,
  key: string,
): Promise<unknown> {
  const access = internalConfigAccess.get(configService);
  if (!access) return undefined;
  return access.read(key);
}

const internalConfigAccess = new WeakMap<
  WeaverConfigService,
  InternalConfigAccess
>();
const registryBindings = new WeakMap<WeaverConfigService, object>();
const pendingBindings = new WeakSet<WeaverConfigService>();

export function serviceRegistryEnvironment(
  service: WeaverConfigService,
): string {
  const access = internalConfigAccess.get(service);
  if (!access)
    throw new Error("Schema registry requires a real config service");
  return access.environment;
}

export function beginRegistryBinding(service: WeaverConfigService): () => void {
  if (!internalConfigAccess.has(service)) {
    throw new Error("Schema registry requires a real config service");
  }
  if (registryBindings.has(service) || pendingBindings.has(service)) {
    throw new Error("Config service already has a schema registry");
  }
  pendingBindings.add(service);
  return () => pendingBindings.delete(service);
}

export function finishRegistryBinding(
  service: WeaverConfigService,
  registry: object,
): void {
  if (!pendingBindings.has(service))
    throw new Error("Schema registry binding was not reserved");
  registryBindings.set(service, registry);
  pendingBindings.delete(service);
}

export function bindInMemoryRegistry(
  service: WeaverConfigService,
  registry: object,
): void {
  // Isolated schema-only fixtures have no internal access and do not bind authority.
  const access = internalConfigAccess.get(service);
  if (!access) return;
  const cancel = beginRegistryBinding(service);
  try {
    if (access.hasPersistedRegistry()) {
      throw new Error(
        "Persisted schema registry must be hydrated before binding",
      );
    }
    finishRegistryBinding(service, registry);
  } finally {
    cancel();
  }
}

export async function readPersistentRegistry(
  service: WeaverConfigService,
  layer: string,
  key: string,
): Promise<unknown> {
  const access = internalConfigAccess.get(service);
  if (!access)
    throw new Error("Schema registry requires a real config service");
  return access.readRegistry(layer, key);
}

export function registerInternalConfigAccess(
  configService: WeaverConfigService,
  access: InternalConfigAccess,
): void {
  internalConfigAccess.set(configService, access);
}

export async function writeInternalConfig(
  configService: WeaverConfigService,
  layer: string,
  key: string,
  value: unknown,
  options?: WriteContext,
): Promise<WriteResult> {
  const access = internalConfigAccess.get(configService);
  if (!access) return missingInternalAccessResult();
  return access.write(layer, key, value, options);
}

export async function removeInternalConfig(
  configService: WeaverConfigService,
  layer: string,
  key: string,
  options?: WriteContext,
): Promise<WriteResult> {
  const access = internalConfigAccess.get(configService);
  if (!access) return missingInternalAccessResult();
  return access.remove(layer, key, options);
}

function missingInternalAccessResult(): WriteResult {
  return {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "Config service does not expose internal write access",
    },
  };
}
