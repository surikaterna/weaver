import { deriveServicePath } from "@weaver-conf/config-engine";
import type {
  ConfigurationPropertySchema,
  SchemaRegistrationRequest as PathSchemaRegistrationRequest,
  SchemaRegistrationAuditMetadata,
  SchemaRegistrationMetadata,
} from "@weaver-conf/config-types";
import type { WeaverError } from "../types/errors";
import { createWeaverError } from "../types/errors";
import type { WeaverConfigService, WriteContext } from "./config-service";
import { writeInternalConfig } from "./config-service-internal";
import {
  parsePersistedRegistry,
  serializeRegistry,
} from "./schema-registry-persistence";
import {
  applyEvaluation,
  cloneState,
  createEmptyState,
  evaluateRegistration,
  listSchemas,
  schemaKey,
} from "./schema-registry-state";

export type SchemaRegistrationRequest = PathSchemaRegistrationRequest;

export interface SchemaRegistrationContext {
  readonly subject?: string | undefined;
  readonly actor?: string | undefined;
}

export interface SchemaRegistrationResult {
  success: boolean;
  isNewSchema: boolean;
  hasBreakingChanges: boolean;
  metadata?: SchemaRegistrationMetadata | undefined;
  breakingChanges?: string[];
  error?: WeaverError;
}

export interface SchemaRegistryOptions {
  configService: WeaverConfigService;
}

export interface PersistentSchemaRegistryOptions extends SchemaRegistryOptions {
  layer?: string;
  key?: string;
  environment?: string;
}

export interface SchemaRegistry {
  register(
    request: SchemaRegistrationRequest,
    context?: SchemaRegistrationContext,
  ): Promise<SchemaRegistrationResult>;
  getSchema(serviceId: string, environment: string): Promise<unknown | null>;
  listAll(): Record<string, ConfigurationPropertySchema>;
}

export type { SchemaRegistrationAuditMetadata };

const defaultPersistenceLayer = "platform";
const defaultPersistenceKey = "_weaver.registry.schemas";

function createSchemaPersistenceWriter(
  options: PersistentSchemaRegistryOptions,
  layer: string,
  key: string,
): ReturnType<typeof persistenceWriter> {
  return persistenceWriter(options, layer, key);
}

function persistenceWriter(
  options: PersistentSchemaRegistryOptions,
  layer: string,
  key: string,
) {
  return async (
    updatedState: ReturnType<typeof createEmptyState>,
    environment: string,
    context: SchemaRegistrationContext | undefined,
  ): Promise<SchemaRegistrationResult | null> => {
    const actor = context?.actor ?? context?.subject;
    const writeContext: WriteContext = {
      environment,
      ...(actor ? { actor } : {}),
    };
    const writeResult = await writeInternalConfig(
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

export function createSchemaRegistry(
  _options: SchemaRegistryOptions,
): SchemaRegistry {
  const state = createEmptyState();
  return {
    async register(request, context) {
      const evaluation = evaluateRegistration(state, request, context);
      applyEvaluation(state, evaluation);
      return evaluation.result;
    },

    async getSchema(serviceId, environment) {
      try {
        const { servicePath } = deriveServicePath(serviceId);
        return (
          state.schemas.get(schemaKey(servicePath, environment))?.schema ?? null
        );
      } catch {
        return null;
      }
    },

    listAll() {
      return listSchemas(state);
    },
  };
}

export async function createPersistentSchemaRegistry(
  options: PersistentSchemaRegistryOptions,
): Promise<SchemaRegistry> {
  const layer = options.layer ?? defaultPersistenceLayer;
  const key = options.key ?? defaultPersistenceKey;
  const defaultEnvironment = options.environment;
  const state = parsePersistedRegistry(await options.configService.get(key));
  const persist = createSchemaPersistenceWriter(options, layer, key);

  return {
    async register(request, context) {
      const environment = request.environment || defaultEnvironment || "";
      const normalizedRequest = { ...request, environment };
      const evaluation = evaluateRegistration(
        state,
        normalizedRequest,
        context,
      );
      if (!evaluation.result.success) return evaluation.result;

      const updatedState = cloneState(state);
      applyEvaluation(updatedState, evaluation);
      const failure = await persist(updatedState, environment, context);
      if (failure) return failure;
      applyEvaluation(state, evaluation);
      return evaluation.result;
    },

    async getSchema(serviceId, environment) {
      try {
        const { servicePath } = deriveServicePath(serviceId);
        return (
          state.schemas.get(schemaKey(servicePath, environment))?.schema ?? null
        );
      } catch {
        return null;
      }
    },

    listAll() {
      return listSchemas(state);
    },
  };
}
