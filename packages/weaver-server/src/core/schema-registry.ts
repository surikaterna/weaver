import {
  assertPublicConfigPath,
  deriveServicePath,
} from "@weaver-conf/config-engine";
import type {
  ConfigurationPropertySchema,
  ObjectConfigurationPropertySchema,
  SchemaRegistrationRequest as PathSchemaRegistrationRequest,
  RegisteredSchemaDetailResponse,
  RegisteredSchemaIdentityListResponse,
  RegisteredSchemaIdentityPageRequest,
  RegisteredSchemaIdentityPageResponse,
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
import {
  buildIdentityIndex,
  SchemaIdentityPages,
} from "./schema-identity-pages";
import {
  parsePersistedRegistry,
  serializeRegistry,
} from "./schema-registry-persistence";
import {
  applyEvaluation,
  cloneState,
  createEmptyState,
  evaluateRegistration,
  listSchemaIdentities,
  listSchemas,
  type SchemaEntry,
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

export interface RegisteredSchemaAnchor {
  readonly kind: "service" | "fragment";
  readonly path: string;
  readonly schema: ObjectConfigurationPropertySchema;
  readonly environment: string;
  readonly metadata: SchemaRegistrationMetadata;
}

export const registeredSchemaAnchorSchema: z.ZodType<RegisteredSchemaAnchor> =
  z.strictObject({
    kind: z.enum(["service", "fragment"]),
    path: z.string(),
    schema: objectConfigurationPropertySchemaSchema,
    environment: z.string(),
    metadata: schemaRegistrationMetadataSchema,
  });

export interface SchemaRegistryOptions {
  configService: WeaverConfigService;
  schemaIdentityMaxPageSize?: number;
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
  ): Promise<ObjectConfigurationPropertySchema | null>;
  resolveAnchor(
    path: string,
    environment?: string,
  ): Promise<RegisteredSchemaAnchor | null>;
  listAll(): Record<string, ConfigurationPropertySchema>;
  listRegisteredSchemaIdentities(): RegisteredSchemaIdentityListResponse;
  listRegisteredSchemaIdentityPage(
    input?: RegisteredSchemaIdentityPageRequest,
  ): RegisteredSchemaIdentityPageResponse;
  getRegisteredSchema(
    path: string,
    environment: string,
  ): RegisteredSchemaDetailResponse | null;
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
  const pages = new SchemaIdentityPages(
    state,
    _options.schemaIdentityMaxPageSize ?? 200,
  );
  return {
    async register(request, context) {
      const evaluation = evaluateRegistration(state, request, context);
      if (!evaluation.result.success) return evaluation.result;
      const candidate = cloneState(state);
      applyEvaluation(candidate, evaluation);
      const index = buildIdentityIndex(candidate);
      pages.assertCanPublish();
      applyEvaluation(state, evaluation);
      pages.publish(index);
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
      return findRegisteredAnchor(
        state.schemas.values(),
        path,
        environment ?? "",
      );
    },

    listAll() {
      return listSchemas(state);
    },
    listRegisteredSchemaIdentities() {
      return listSchemaIdentities(state);
    },
    listRegisteredSchemaIdentityPage(input) {
      return pages.page(input);
    },
    getRegisteredSchema(path, environment) {
      const entry = state.schemas.get(schemaKey(path, environment));
      return entry?.path === path && entry.environment === environment
        ? registeredAnchorFromEntry(entry)
        : null;
    },
  };
}

function getRegisteredServiceSchema(
  schemas: ReadonlyMap<string, SchemaEntry>,
  serviceId: string,
  environment: string,
): ObjectConfigurationPropertySchema | null {
  try {
    const { servicePath } = deriveServicePath(serviceId);
    return schemas.get(schemaKey(servicePath, environment))?.schema ?? null;
  } catch {
    return null;
  }
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
  const pages = new SchemaIdentityPages(
    state,
    options.schemaIdentityMaxPageSize ?? 200,
  );
  let pending: Promise<unknown> = Promise.resolve();

  function registerSerialized(
    request: SchemaRegistrationRequest,
    context?: SchemaRegistrationContext,
  ): Promise<SchemaRegistrationResult> {
    const work = pending.then(async () => {
      const environment = request.environment || defaultEnvironment || "";
      const evaluation = evaluateRegistration(
        state,
        { ...request, environment },
        context,
      );
      if (!evaluation.result.success) return evaluation.result;
      const candidate = cloneState(state);
      applyEvaluation(candidate, evaluation);
      const index = buildIdentityIndex(candidate);
      pages.assertCanPublish();
      const failure = await persist(candidate, environment, context);
      if (failure) return failure;
      applyEvaluation(state, evaluation);
      pages.publish(index);
      return evaluation.result;
    });
    pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  return {
    register: registerSerialized,

    async getSchema(serviceId, environment) {
      return getRegisteredServiceSchema(state.schemas, serviceId, environment);
    },

    async resolveAnchor(path, environment) {
      return findRegisteredAnchor(
        state.schemas.values(),
        path,
        environment ?? defaultEnvironment ?? "",
      );
    },

    listAll() {
      return listSchemas(state);
    },
    listRegisteredSchemaIdentities() {
      return listSchemaIdentities(state);
    },
    listRegisteredSchemaIdentityPage(input) {
      return pages.page(input);
    },
    getRegisteredSchema(path, environment) {
      const entry = state.schemas.get(schemaKey(path, environment));
      return entry?.path === path && entry.environment === environment
        ? registeredAnchorFromEntry(entry)
        : null;
    },
  };
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
