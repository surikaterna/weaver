import type {
  CanonicalSchemaRegistryReader,
  SchemaRegistrationContext,
  SchemaRegistrationRequest,
  SchemaRegistrationResult,
} from "@weaver-conf/config-registry";
import {
  createRegistryAdapter,
  type RegistryState,
} from "@weaver-conf/config-registry/internal/server-adapter";
import { createWeaverError } from "../types/errors";
import {
  beginRegistryBinding,
  bindInMemoryRegistry,
  finishRegistryBinding,
  INTERNAL_SCHEMA_REGISTRY_KEY,
  inMemoryRegistryEnvironment,
  readPersistentRegistry,
  serializeConfigMutation,
  serviceRegistryEnvironment,
  writeRegistryInternalConfig,
} from "./config-service-internal";
import type { WeaverConfigService, WriteContext } from "./config-service-types";
import {
  parsePersistedRegistry,
  serializeRegistry,
} from "./schema-registry-persistence";

export type {
  RegisteredSchemaAnchor,
  SchemaRegistrationAuditMetadata,
  SchemaRegistrationContext,
  SchemaRegistrationRequest,
  SchemaRegistrationResult,
} from "@weaver-conf/config-registry";
export { registeredSchemaAnchorSchema } from "@weaver-conf/config-registry";

export interface SchemaRegistryOptions {
  configService: WeaverConfigService;
  schemaIdentityMaxPageSize?: number;
}

export interface PersistentSchemaRegistryOptions extends SchemaRegistryOptions {
  layer?: string;
  key?: string;
  environment?: string;
}

export interface SchemaRegistry
  extends Omit<CanonicalSchemaRegistryReader, "getSchema" | "resolveAnchor"> {
  register(
    request: SchemaRegistrationRequest,
    context?: SchemaRegistrationContext,
  ): Promise<SchemaRegistrationResult>;
  getSchema(
    ...args: Parameters<CanonicalSchemaRegistryReader["getSchema"]>
  ): Promise<ReturnType<CanonicalSchemaRegistryReader["getSchema"]>>;
  resolveAnchor(
    ...args: Parameters<CanonicalSchemaRegistryReader["resolveAnchor"]>
  ): Promise<ReturnType<CanonicalSchemaRegistryReader["resolveAnchor"]>>;
}

const defaultPersistenceLayer = "platform";
const defaultPersistenceKey = INTERNAL_SCHEMA_REGISTRY_KEY;

function persistenceWriter(
  options: PersistentSchemaRegistryOptions,
  layer: string,
  key: string,
) {
  return async (
    updatedState: RegistryState,
    environment: string,
    context: SchemaRegistrationContext | undefined,
  ): Promise<SchemaRegistrationResult | null> => {
    const actor = context?.actor ?? context?.subject;
    const writeContext: WriteContext = {
      environment,
      ...(actor ? { actor } : {}),
    };
    const writeResult = await writeRegistryInternalConfig(
      options.configService,
      layer,
      key,
      serializeRegistry(updatedState),
      writeContext,
    );
    if (writeResult.success) return null;
    return {
      success: false,
      isNewSchema: false,
      hasBreakingChanges: false,
      error: createWeaverError(
        "INTERNAL_ERROR",
        writeResult.error?.message ?? "Failed to persist schema registry",
      ),
    };
  };
}

function serverRegistry(
  reader: CanonicalSchemaRegistryReader,
  register: SchemaRegistry["register"],
): SchemaRegistry {
  return {
    ...reader,
    register,
    async getSchema(serviceId, environment) {
      return reader.getSchema(serviceId, environment);
    },
    async resolveAnchor(path, environment) {
      return reader.resolveAnchor(path, environment);
    },
  };
}

export function createSchemaRegistry(
  options: SchemaRegistryOptions,
): SchemaRegistry {
  const adapter = createRegistryAdapter({
    defaultEnvironment: inMemoryRegistryEnvironment(options.configService),
    ...(options.schemaIdentityMaxPageSize !== undefined
      ? { schemaIdentityMaxPageSize: options.schemaIdentityMaxPageSize }
      : {}),
  });
  const registry = serverRegistry(adapter.reader, (request, context) =>
    serializeConfigMutation(options.configService, async () => {
      const prepared = adapter.prepare(request, context);
      if (prepared.result.success) prepared.publish();
      return prepared.result;
    }),
  );
  bindInMemoryRegistry(options.configService, registry);
  return registry;
}

export async function createPersistentSchemaRegistry(
  options: PersistentSchemaRegistryOptions,
): Promise<SchemaRegistry> {
  const key = options.key === undefined ? defaultPersistenceKey : options.key;
  if (key !== defaultPersistenceKey) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Persistent schema registry key must be the canonical internal key",
    );
  }
  const cancelBinding = beginRegistryBinding(options.configService);
  try {
    return await hydratePersistentRegistry(options, key);
  } finally {
    cancelBinding();
  }
}

async function hydratePersistentRegistry(
  options: PersistentSchemaRegistryOptions,
  key: string,
): Promise<SchemaRegistry> {
  const layer = options.layer ?? defaultPersistenceLayer;
  const defaultEnvironment =
    serviceRegistryEnvironment(options.configService) ?? "";
  const state = parsePersistedRegistry(
    await readPersistentRegistry(options.configService, layer, key),
  );
  const adapter = createRegistryAdapter(
    {
      defaultEnvironment,
      ...(options.schemaIdentityMaxPageSize !== undefined
        ? { schemaIdentityMaxPageSize: options.schemaIdentityMaxPageSize }
        : {}),
    },
    state,
  );
  const persist = persistenceWriter(options, layer, key);
  const register = persistentRegistrationQueue(
    options.configService,
    adapter,
    persist,
    defaultEnvironment,
  );
  const registry = serverRegistry(adapter.reader, register);
  finishRegistryBinding(options.configService, registry);
  return registry;
}

function persistentRegistrationQueue(
  service: WeaverConfigService,
  adapter: ReturnType<typeof createRegistryAdapter>,
  persist: ReturnType<typeof persistenceWriter>,
  defaultEnvironment: string,
): SchemaRegistry["register"] {
  let pending: Promise<unknown> = Promise.resolve();
  return (request, context) => {
    const work = pending.then(() =>
      serializeConfigMutation(service, async () => {
        const environment = request.environment || defaultEnvironment || "";
        const prepared = adapter.prepare({ ...request, environment }, context);
        if (!prepared.result.success) return prepared.result;
        const candidate = prepared.candidate;
        if (!candidate) return prepared.result;
        const failure = await persist(candidate, environment, context);
        if (failure) return failure;
        prepared.publish();
        return prepared.result;
      }),
    );
    pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };
}
