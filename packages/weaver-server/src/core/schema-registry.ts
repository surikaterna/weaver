import {
  assertPublicConfigPath,
  deriveServicePath,
} from "@weaver-conf/config-engine";
import type {
  ConfigurationPropertySchema,
  ObjectConfigurationPropertySchema,
  SchemaRegistrationRequest as PathSchemaRegistrationRequest,
  SchemaRegistrationAuditMetadata,
  SchemaRegistrationMetadata,
} from "@weaver-conf/config-types";
import {
  objectConfigurationPropertySchemaSchema,
  schemaRegistrationMetadataSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";
import type { WeaverError } from "../types/errors";
import { createWeaverError } from "../types/errors";
import {
  readInternalConfig,
  writeInternalConfig,
} from "./config-service-internal";
import type { WeaverConfigService, WriteContext } from "./config-service-types";
import type { SchemaOperationContext } from "./schema-operation-context";
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
  type SchemaEntry,
  schemaKey,
} from "./schema-registry-state";
import { bindSchemaRegistry } from "./schema-write-boundary";

export type SchemaRegistrationRequest = PathSchemaRegistrationRequest;

export interface SchemaRegistrationContext {
  readonly subject?: string | undefined;
  readonly actor?: string | undefined;
  readonly operation?: SchemaOperationContext | undefined;
}

export interface SchemaRegistrationResult {
  success: boolean;
  isNewSchema: boolean;
  hasBreakingChanges: boolean;
  metadata?: SchemaRegistrationMetadata | undefined;
  breakingChanges?: string[];
  error?: WeaverError;
}

export interface RegisteredSchemaAnchor {
  readonly kind: "service" | "fragment";
  readonly path: string;
  readonly schema: ObjectConfigurationPropertySchema;
  readonly environment: string;
  readonly metadata: SchemaRegistrationMetadata;
}

export const registeredSchemaAnchorSchema = z.strictObject({
  kind: z.enum(["service", "fragment"]),
  path: z.string(),
  schema: objectConfigurationPropertySchemaSchema,
  environment: z.string(),
  metadata: schemaRegistrationMetadataSchema,
});

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
  getSchema(
    serviceId: string,
    environment: string,
  ): Promise<ConfigurationPropertySchema | null>;
  resolveAnchor(
    path: string,
    environment: string,
  ): Promise<RegisteredSchemaAnchor | null>;
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
  options: SchemaRegistryOptions,
): SchemaRegistry {
  const state = createEmptyState();
  const registry: SchemaRegistry = {
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

    async resolveAnchor(path, environment) {
      return findRegisteredAnchor(state.schemas.values(), path, environment);
    },

    listAll() {
      return listSchemas(state);
    },
  };
  bindRegistry(options.configService, registry, () => state.schemas.values());
  return registry;
}

export async function createPersistentSchemaRegistry(
  options: PersistentSchemaRegistryOptions,
): Promise<SchemaRegistry> {
  const layer = options.layer ?? defaultPersistenceLayer;
  const key = options.key ?? defaultPersistenceKey;
  const defaultEnvironment = options.environment;
  const state = parsePersistedRegistry(
    await readInternalConfig(options.configService, key),
  );
  const persist = createSchemaPersistenceWriter(options, layer, key);

  const registry: SchemaRegistry = {
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

    async resolveAnchor(path, environment) {
      return findRegisteredAnchor(state.schemas.values(), path, environment);
    },

    listAll() {
      return listSchemas(state);
    },
  };
  bindRegistry(options.configService, registry, () => state.schemas.values());
  return registry;
}

function bindRegistry(
  service: WeaverConfigService,
  registry: SchemaRegistry,
  entries: () => Iterable<SchemaEntry>,
): void {
  bindSchemaRegistry(service, registry, (path, environment) =>
    findAffectedAnchors(entries(), path, environment),
  );
}

function findAffectedAnchors(
  entries: Iterable<SchemaEntry>,
  path: string,
  environment: string,
): RegisteredSchemaAnchor[] {
  const ancestors: RegisteredSchemaAnchor[] = [];
  const descendants: RegisteredSchemaAnchor[] = [];
  for (const entry of entries) {
    const anchor = registeredAnchorFromEntry(entry);
    if (anchor.environment !== environment) continue;
    if (isAnchorPathMatch(anchor.path, path)) ancestors.push(anchor);
    else if (isAnchorPathMatch(path, anchor.path)) descendants.push(anchor);
  }
  const deepest = ancestors.sort(
    (left, right) => right.path.length - left.path.length,
  )[0];
  return [...(deepest ? [deepest] : []), ...descendants];
}

function findRegisteredAnchor(
  entries: Iterable<SchemaEntry>,
  path: string,
  environment: string,
): RegisteredSchemaAnchor | null {
  const normalizedPath = normalizeAnchorLookupPath(path);
  if (normalizedPath === null) return null;
  let match: RegisteredSchemaAnchor | null = null;

  for (const entry of entries) {
    const anchor = registeredAnchorFromEntry(entry);
    if (anchor.environment !== environment) continue;
    if (!isAnchorPathMatch(anchor.path, normalizedPath)) continue;
    if (match === null || anchor.path.length > match.path.length)
      match = anchor;
  }

  return match;
}

function registeredAnchorFromEntry(entry: SchemaEntry): RegisteredSchemaAnchor {
  return {
    kind: entry.kind,
    path: entry.path,
    schema: entry.schema,
    environment: entry.environment,
    metadata: entry.metadata,
  };
}

function isAnchorPathMatch(anchorPath: string, path: string): boolean {
  return path === anchorPath || path.startsWith(`${anchorPath}/`);
}

function normalizeAnchorLookupPath(path: string): string | null {
  try {
    return assertPublicConfigPath(path);
  } catch {
    return null;
  }
}
