import { deepGet } from "@weaver-conf/config-engine";
import type {
  ConfigurationStorageProvider,
  WriteResult,
} from "@weaver-conf/config-types";
import type { WeaverConfigService, WriteContext } from "./config-service-types";
import type { SchemaRegistry } from "./schema-registry";

export const INTERNAL_SCHEMA_REGISTRY_KEY = "_weaver.registry.schemas";

function requireRegistryKey(key: string): void {
  if (key !== INTERNAL_SCHEMA_REGISTRY_KEY) {
    throw new Error(
      "Persistent schema registry key must be the canonical internal key",
    );
  }
}

function permittedInternalKey(key: string): boolean {
  return (
    key === INTERNAL_SCHEMA_REGISTRY_KEY ||
    key === "_weaver.pinned" ||
    (key.startsWith("_weaver.scope.") &&
      key.length > "_weaver.scope.".length) ||
    (key.startsWith("_weaver.pinned.") && key.length > "_weaver.pinned.".length)
  );
}

function restrictedInternalKeyResult(): WriteResult {
  return {
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message: "Internal writes require an approved protected config key",
    },
  };
}

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

interface RegistryProviderAccess {
  readonly environment: string;
  readonly configuredProviders: readonly ConfigurationStorageProvider[];
  readonly providers: readonly ConfigurationStorageProvider[];
  readonly degradedProviders: readonly string[];
  readonly layerData: ReadonlyMap<string, Record<string, unknown>>;
  readonly resolveProvider: (
    layer: string,
  ) => ConfigurationStorageProvider | undefined;
}

interface ScopedLayerProvider {
  loadLayer(layer: string): Promise<{ entries: Record<string, unknown> }>;
  writeLayer(layer: string, key: string, value: unknown): Promise<WriteResult>;
  removeLayer(layer: string, key: string): Promise<WriteResult>;
}

export function hasScopedLayerIo(
  provider: ConfigurationStorageProvider,
): provider is ConfigurationStorageProvider & ScopedLayerProvider {
  return (
    typeof (provider as Partial<ScopedLayerProvider>).loadLayer ===
      "function" &&
    typeof (provider as Partial<ScopedLayerProvider>).writeLayer ===
      "function" &&
    typeof (provider as Partial<ScopedLayerProvider>).removeLayer === "function"
  );
}

function registryRoot(entries: Record<string, unknown>): unknown {
  const internal = entries._weaver;
  if (
    internal !== undefined &&
    (internal === null ||
      typeof internal !== "object" ||
      Array.isArray(internal))
  )
    throw new Error("Persisted internal config root is invalid");
  return deepGet(entries, "_weaver.registry");
}

export function createRegistryAccess(
  options: RegistryProviderAccess,
): Pick<
  InternalConfigAccess,
  "environment" | "hasPersistedRegistry" | "readRegistry"
> {
  const {
    configuredProviders,
    providers,
    degradedProviders,
    layerData,
    resolveProvider,
  } = options;
  const entriesFor = (provider: ConfigurationStorageProvider) =>
    layerData.get(provider.id) ?? {};
  return {
    environment: options.environment,
    hasPersistedRegistry: () => {
      if (
        providers.length === 0 ||
        configuredProviders.some(
          (provider) =>
            provider.layer === "platform" &&
            degradedProviders.includes(provider.id),
        )
      )
        throw new Error("Schema registry provider is unavailable");
      return providers.some(
        (provider) => registryRoot(entriesFor(provider)) !== undefined,
      );
    },
    readRegistry: async (layer, key) => {
      requireRegistryKey(key);
      const provider = resolveProvider(layer);
      if (!provider)
        throw new Error(
          `Schema registry provider for layer "${layer}" is unavailable`,
        );
      const entries = entriesFor(provider);
      const root = registryRoot(entries);
      const value = deepGet(entries, key);
      if (value === undefined && root !== undefined)
        throw new Error("Persisted schema registry is incomplete");
      return value;
    },
  };
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
const registryBindings = new WeakMap<WeaverConfigService, SchemaRegistry>();
const pendingBindings = new WeakSet<WeaverConfigService>();
const mutations = new WeakMap<WeaverConfigService, Promise<unknown>>();

export function boundSchemaRegistry(
  service: WeaverConfigService,
): SchemaRegistry | undefined {
  return registryBindings.get(service);
}

export function serializeConfigMutation<T>(
  service: WeaverConfigService,
  task: () => Promise<T>,
): Promise<T> {
  const pending = mutations.get(service) ?? Promise.resolve();
  const work = pending.then(task);
  mutations.set(
    service,
    work.then(
      () => undefined,
      () => undefined,
    ),
  );
  return work;
}

export function serviceRegistryEnvironment(
  service: WeaverConfigService,
): string {
  const access = internalConfigAccess.get(service);
  if (!access)
    throw new Error("Schema registry requires a real config service");
  return access.environment;
}

export function inMemoryRegistryEnvironment(
  service: WeaverConfigService,
): string {
  return internalConfigAccess.get(service)?.environment ?? "";
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
  registry: SchemaRegistry,
): void {
  if (!pendingBindings.has(service))
    throw new Error("Schema registry binding was not reserved");
  registryBindings.set(service, registry);
  pendingBindings.delete(service);
}

export function bindInMemoryRegistry(
  service: WeaverConfigService,
  registry: SchemaRegistry,
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
  requireRegistryKey(key);
  const access = internalConfigAccess.get(service);
  if (!access)
    throw new Error("Schema registry requires a real config service");
  return access.readRegistry(layer, key);
}

export async function writeRegistryInternalConfig(
  configService: WeaverConfigService,
  layer: string,
  key: string,
  value: unknown,
  options?: WriteContext,
): Promise<WriteResult> {
  requireRegistryKey(key);
  return writeInternalConfig(configService, layer, key, value, options);
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
  if (!permittedInternalKey(key)) return restrictedInternalKeyResult();
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
  if (!permittedInternalKey(key)) return restrictedInternalKeyResult();
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
