import {
  assertPublicConfigPath,
  deriveServicePath,
} from "@weaver-conf/config-engine";
import type {
  ConfigurationPropertySchema,
  ObjectConfigurationPropertySchema,
  SchemaRegistrationRequest as PathSchemaRegistrationRequest,
  SchemaRegistrationAuditMetadata,
  SchemaRegistrationContext,
  SchemaRegistrationMetadata,
  SchemaRegistrationResponse,
} from "@weaver-conf/config-types";
import {
  environmentNameSchema,
  registeredConfigurationSchemaSchema,
  schemaRegistrationContextSchema,
  schemaRegistrationMetadataSchema,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import { z } from "zod";
import { createWeaverError } from "../types/errors";
import { prepareCanonicalRegistration } from "./canonical-registration";
import type { ApplicationControlTransaction } from "./config-application-transaction";
import { snapshotMutationInput } from "./config-mutation-input";
import {
  applicationAdmission,
  applicationControlTransaction,
  applicationProjection,
  controlProjection,
  controlTransaction,
  schemaRegistryTransactionMode,
} from "./config-service-internal";
import type { WeaverConfigService } from "./config-service-types";
import { writeResultError } from "./config-write-errors";
import { notifySchemaRegistration } from "./schema-read-boundary";
import { composeRegistryEntries } from "./schema-registry-composition";
import {
  listSchemas,
  type SchemaEntry,
  schemaKey,
} from "./schema-registry-state";

export type SchemaRegistrationRequest = PathSchemaRegistrationRequest;

export type { SchemaRegistrationContext } from "@weaver-conf/config-types";
export type SchemaRegistrationResult = SchemaRegistrationResponse;

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
  schema: registeredConfigurationSchemaSchema,
  environment: environmentNameSchema,
  metadata: schemaRegistrationMetadataSchema,
});

export interface SchemaRegistryOptions {
  configService: WeaverConfigService;
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

export function createSchemaRegistry(
  options: SchemaRegistryOptions,
): SchemaRegistry {
  if (Object.keys(options).some((key) => key !== "configService"))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Registry options cannot select alternate storage or environment",
    );
  const service = options.configService;
  controlProjection(service).prepared();
  return {
    register: (request, context) =>
      registerCanonical(service, request, context),
    async getSchema(serviceId, environment) {
      const state = registryProjection(service).registrations().state;
      try {
        const { servicePath } = deriveServicePath(serviceId);
        return structuredClone(
          state.schemas.get(schemaKey(servicePath, environment))?.schema ??
            null,
        );
      } catch {
        return null;
      }
    },
    async resolveAnchor(path, environment) {
      const state = registryProjection(service).registrations().state;
      return structuredClone(
        findRegisteredAnchor(composeRegistryEntries(state), path, environment),
      );
    },
    listAll() {
      return structuredClone(
        listSchemas(registryProjection(service).registrations().state),
      );
    },
  };
}

async function registerCanonical(
  service: WeaverConfigService,
  request: SchemaRegistrationRequest,
  context?: SchemaRegistrationContext,
): Promise<SchemaRegistrationResult> {
  return registerCanonicalWithMode(service, request, context);
}

export function registerControlSchema(
  service: WeaverConfigService,
  request: SchemaRegistrationRequest,
  context?: SchemaRegistrationContext,
): Promise<SchemaRegistrationResult> {
  return registerCanonicalWithMode(service, request, context);
}

async function registerCanonicalWithMode(
  service: WeaverConfigService,
  request: SchemaRegistrationRequest,
  context: SchemaRegistrationContext | undefined,
): Promise<SchemaRegistrationResult> {
  try {
    const mode = schemaRegistryTransactionMode(service);
    const ownedRequest = snapshotMutationInput(request);
    const validatedContext = schemaRegistrationContextSchema.parse(
      context ?? {},
    );
    return await registerTransaction(
      service,
      mode,
      async ({ read, write, revision }) => {
        const { record, id, existing, changed, evaluation, compatibility } =
          prepareCanonicalRegistration(read(), ownedRequest, validatedContext);
        if (!evaluation.result.success) return evaluation.result;
        assertRegistrationRevision(revision, !!changed, validatedContext);
        if (existing && !changed)
          return {
            ...evaluation.result,
            ...compatibility,
            revision,
          };
        const result = await write(
          `_weaver.catalog.registrations.${id}`,
          record,
          { expectedRevision: revision },
        );
        if (!result.success) throw writeResultError(result);
        if (evaluation.entry && applicationAdmission(service))
          await notifySchemaRegistration(service, evaluation.entry.path);
        return {
          ...evaluation.result,
          isNewSchema: !existing,
          ...compatibility,
          revision: result.revision ?? revision,
        };
      },
    );
  } catch (error) {
    return failedRegistration(error);
  }
}

function registerTransaction(
  service: WeaverConfigService,
  mode: "application" | "draft-control",
  operation: (
    transaction: ApplicationControlTransaction,
  ) => Promise<SchemaRegistrationResult>,
): Promise<SchemaRegistrationResult> {
  const run =
    mode === "draft-control"
      ? controlTransaction
      : applicationControlTransaction;
  return run(service, "catalog", operation);
}

function registryProjection(service: WeaverConfigService) {
  return schemaRegistryTransactionMode(service) === "draft-control"
    ? controlProjection(service)
    : applicationProjection(service);
}

function assertRegistrationRevision(
  revision: string,
  changed: boolean,
  context?: SchemaRegistrationContext,
): void {
  if (
    (changed && context?.expectedRevision === undefined) ||
    (context?.expectedRevision !== undefined &&
      context.expectedRevision !== revision)
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Schema activation requires the current authoritative revision",
    );
}

function failedRegistration(error: unknown): SchemaRegistrationResult {
  return {
    success: false,
    isNewSchema: false,
    hasBreakingChanges: false,
    error:
      error instanceof WeaverErrorInstance
        ? error
        : createWeaverError("VALIDATION_ERROR", String(error)),
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
