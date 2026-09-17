import {
  deriveCanonicalSlotPath,
  deriveFragmentPath,
  deriveServicePath,
  detectBreakingChanges,
  schemasEqual,
} from "@weaver-conf/config-engine";
import type {
  ConfigurationPropertySchema,
  FragmentSlotRegistrationMetadata,
  SchemaRegistrationAuditMetadata,
  SchemaRegistrationMetadata,
  SchemaRegistrationRequest,
} from "@weaver-conf/config-types";
import {
  fragmentSchemaRegistrationRequestSchema,
  serviceSchemaRegistrationRequestSchema,
} from "@weaver-conf/config-types";
import { createWeaverError } from "../types/errors";
import type {
  SchemaRegistrationContext,
  SchemaRegistrationResult,
} from "./schema-registry";

export interface SchemaEntry {
  readonly kind: "service" | "fragment";
  readonly path: string;
  readonly schema: ConfigurationPropertySchema;
  readonly environment: string;
  readonly metadata: SchemaRegistrationMetadata;
}

export interface RegistryState {
  readonly schemas: Map<string, SchemaEntry>;
  readonly slots: Map<string, FragmentSlotRegistrationMetadata>;
}

export interface RegistrationEvaluation {
  readonly result: SchemaRegistrationResult;
  readonly entry?: SchemaEntry | undefined;
  readonly key?: string | undefined;
  readonly slots?: ReadonlyArray<FragmentSlotRegistrationMetadata> | undefined;
  readonly slotKeysToRemove?: ReadonlyArray<string> | undefined;
}

type ParsedRegistration =
  | {
      readonly success: true;
      readonly kind: "service" | "fragment";
      readonly schema: ConfigurationPropertySchema;
      readonly environment: string;
      readonly metadata: SchemaRegistrationMetadata;
      readonly targetPath: string;
      readonly slots: ReadonlyArray<FragmentSlotRegistrationMetadata>;
    }
  | { readonly success: false; readonly result: SchemaRegistrationResult };

type ParsedSuccessfulRegistration = Extract<
  ParsedRegistration,
  { success: true }
>;

export function schemaKey(path: string, environment: string): string {
  return `${path}:${environment}`;
}

export function createEmptyState(): RegistryState {
  return { schemas: new Map(), slots: new Map() };
}

export function cloneState(state: RegistryState): RegistryState {
  return { schemas: new Map(state.schemas), slots: new Map(state.slots) };
}

export function listSchemas(
  state: RegistryState,
): Record<string, ConfigurationPropertySchema> {
  const result: Record<string, ConfigurationPropertySchema> = {};
  for (const [key, entry] of state.schemas) result[key] = entry.schema;
  return result;
}

export function applyEvaluation(
  state: RegistryState,
  evaluation: RegistrationEvaluation,
): void {
  if (evaluation.entry && evaluation.key)
    state.schemas.set(evaluation.key, evaluation.entry);
  for (const key of evaluation.slotKeysToRemove ?? []) state.slots.delete(key);
  for (const slot of evaluation.slots ?? []) {
    state.slots.set(schemaKey(slot.canonicalSlotPath, slot.environment), slot);
  }
}

export function evaluateRegistration(
  state: RegistryState,
  request: SchemaRegistrationRequest,
  context?: SchemaRegistrationContext,
): RegistrationEvaluation {
  const parsed = parseRegistrationRequest(request, context);
  if (!parsed.success) return { result: parsed.result };

  const key = schemaKey(parsed.targetPath, parsed.environment);
  if (parsed.kind === "fragment")
    return evaluateFragmentRegistration(state, parsed, key);

  const staleSlots = findRemovedSlots(state, parsed);
  const occupiedSlot = staleSlots.find((slot) =>
    hasRegisteredFragment(state, slot),
  );
  if (occupiedSlot) {
    return validationFailure(
      `Cannot remove fragment slot "${occupiedSlot.canonicalSlotPath}" while fragments are registered`,
    );
  }

  const existing = state.schemas.get(key);
  const result = existing
    ? evaluateExistingRegistration(existing, parsed.schema, parsed.metadata)
    : newSchemaResult(parsed.metadata);
  return {
    result,
    entry: schemaEntry(parsed, key),
    key,
    slots: parsed.slots,
    slotKeysToRemove: staleSlots.map((slot) =>
      schemaKey(slot.canonicalSlotPath, slot.environment),
    ),
  };
}

function findRemovedSlots(
  state: RegistryState,
  parsed: ParsedSuccessfulRegistration,
): FragmentSlotRegistrationMetadata[] {
  const nextSlotPaths = new Set(
    parsed.slots.map((slot) => slot.canonicalSlotPath),
  );
  return [...state.slots.values()].filter(
    (slot) =>
      slot.servicePath === parsed.targetPath &&
      slot.environment === parsed.environment &&
      !nextSlotPaths.has(slot.canonicalSlotPath),
  );
}

function hasRegisteredFragment(
  state: RegistryState,
  slot: FragmentSlotRegistrationMetadata,
): boolean {
  const fragmentRoot = `${slot.canonicalSlotPath}/`;
  for (const entry of state.schemas.values()) {
    if (entry.kind !== "fragment") continue;
    if (entry.environment !== slot.environment) continue;
    if (entry.path.startsWith(fragmentRoot)) return true;
  }
  return false;
}

function parseRegistrationRequest(
  request: SchemaRegistrationRequest,
  context?: SchemaRegistrationContext,
): ParsedRegistration {
  try {
    if ("providerId" in request)
      return parseFragmentRegistration(request, context);
    return parseServiceRegistration(request, context);
  } catch (error: unknown) {
    return parsedValidationFailure(errorMessage(error));
  }
}

function parseServiceRegistration(
  request: SchemaRegistrationRequest,
  context?: SchemaRegistrationContext,
): ParsedRegistration {
  const parsed = serviceSchemaRegistrationRequestSchema.safeParse(request);
  if (!parsed.success) return parsedValidationFailure(parsed.error.message);
  const data = parsed.data;
  const service = deriveServicePath(data.serviceId);
  const audit = buildAudit(context);
  const metadata: SchemaRegistrationMetadata = {
    ...service,
    environment: data.environment,
    providerId: data.serviceId,
    owner: data.owner,
    ...(data.schemaVersion ? { schemaVersion: data.schemaVersion } : {}),
    ...(audit ? { audit } : {}),
  };
  return {
    success: true,
    kind: "service",
    schema: data.schema,
    environment: data.environment,
    metadata,
    targetPath: service.servicePath,
    slots: deriveSlotMetadata(data, service.servicePath, audit),
  };
}

function deriveSlotMetadata(
  request: Extract<SchemaRegistrationRequest, { fragmentSlots: unknown }>,
  servicePath: string,
  audit: SchemaRegistrationAuditMetadata | undefined,
): ReadonlyArray<FragmentSlotRegistrationMetadata> {
  const seen = new Set<string>();
  return request.fragmentSlots.map((slot) => {
    const canonicalSlotPath = deriveCanonicalSlotPath(
      request.serviceId,
      slot.slotPath,
    );
    if (seen.has(canonicalSlotPath)) {
      throw createWeaverError(
        "VALIDATION_ERROR",
        `Duplicate fragment slot "${canonicalSlotPath}"`,
      );
    }
    seen.add(canonicalSlotPath);
    return {
      serviceId: request.serviceId,
      servicePath,
      slotPath: canonicalSlotPath.slice(servicePath.length),
      canonicalSlotPath,
      environment: request.environment,
      providerId: request.serviceId,
      owner: request.owner,
      accepts: slot.accepts,
      ...(request.schemaVersion
        ? { schemaVersion: request.schemaVersion }
        : {}),
      ...(audit ? { audit } : {}),
    };
  });
}

function parseFragmentRegistration(
  request: SchemaRegistrationRequest,
  context?: SchemaRegistrationContext,
): ParsedRegistration {
  const parsed = fragmentSchemaRegistrationRequestSchema.safeParse(request);
  if (!parsed.success) return parsedValidationFailure(parsed.error.message);
  const data = parsed.data;
  const derived = deriveFragmentPath(
    data.serviceId,
    data.slotPath,
    data.providerId,
  );
  const audit = buildAudit(context);
  return {
    success: true,
    kind: "fragment",
    schema: data.schema,
    environment: data.environment,
    metadata: {
      ...derived,
      environment: data.environment,
      owner: data.owner,
      ...(data.schemaVersion ? { schemaVersion: data.schemaVersion } : {}),
      ...(audit ? { audit } : {}),
    },
    targetPath: derived.fragmentPath,
    slots: [],
  };
}

function evaluateFragmentRegistration(
  state: RegistryState,
  parsed: ParsedSuccessfulRegistration,
  key: string,
): RegistrationEvaluation {
  const slotPath = parsed.metadata.canonicalSlotPath;
  if (!slotPath || !state.slots.has(schemaKey(slotPath, parsed.environment))) {
    return validationFailure(`Unknown fragment slot "${slotPath ?? ""}"`);
  }
  if (state.schemas.has(key)) {
    return validationFailure(
      `Duplicate fragment registration for "${parsed.targetPath}"`,
    );
  }
  return {
    result: newSchemaResult(parsed.metadata),
    entry: schemaEntry(parsed, key),
    key,
  };
}

function schemaEntry(
  parsed: ParsedSuccessfulRegistration,
  key: string,
): SchemaEntry {
  return {
    kind: parsed.kind,
    path: key.slice(0, key.length - parsed.environment.length - 1),
    schema: parsed.schema,
    environment: parsed.environment,
    metadata: parsed.metadata,
  };
}

function buildAudit(
  context: SchemaRegistrationContext | undefined,
): SchemaRegistrationAuditMetadata | undefined {
  if (!context?.subject && !context?.actor) return undefined;
  return {
    ...(context.subject ? { subject: context.subject } : {}),
    ...(context.actor ? { actor: context.actor } : {}),
  };
}

function newSchemaResult(
  metadata: SchemaRegistrationMetadata,
): SchemaRegistrationResult {
  return {
    success: true,
    isNewSchema: true,
    hasBreakingChanges: false,
    metadata,
  };
}

function evaluateExistingRegistration(
  existing: SchemaEntry,
  schema: ConfigurationPropertySchema,
  metadata: SchemaRegistrationMetadata,
): SchemaRegistrationResult {
  if (schemasEqual(existing.schema, schema)) {
    return {
      success: true,
      isNewSchema: false,
      hasBreakingChanges: false,
      metadata,
    };
  }

  const breakingChanges = detectBreakingChanges(existing.schema, schema);
  return {
    success: true,
    isNewSchema: false,
    hasBreakingChanges: breakingChanges.length > 0,
    metadata,
    ...(breakingChanges.length > 0
      ? { breakingChanges: breakingChanges.map((c) => c.message) }
      : {}),
  };
}

function parsedValidationFailure(message: string): ParsedRegistration {
  return { success: false, result: validationFailure(message).result };
}

function validationFailure(message: string): RegistrationEvaluation {
  return {
    result: {
      success: false,
      isNewSchema: false,
      hasBreakingChanges: false,
      error: createWeaverError("VALIDATION_ERROR", message),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
