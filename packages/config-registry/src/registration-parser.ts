import {
  deriveCanonicalSlotPath,
  deriveFragmentPath,
  deriveServicePath,
} from "@weaver-conf/config-engine";
import type {
  FragmentSlotRegistrationMetadata,
  ObjectConfigurationPropertySchema,
  SchemaRegistrationMetadata,
  SchemaRegistrationRequest,
} from "@weaver-conf/config-types";
import {
  createWeaverError,
  fragmentSchemaRegistrationRequestSchema,
  serviceSchemaRegistrationRequestSchema,
} from "@weaver-conf/config-types";
import type { SchemaRegistrationResult } from "./registry-contracts";

export type ParsedRegistration =
  | {
      readonly success: true;
      readonly kind: "service" | "fragment";
      readonly schema: ObjectConfigurationPropertySchema;
      readonly environment: string;
      readonly metadata: SchemaRegistrationMetadata;
      readonly targetPath: string;
      readonly slots: ReadonlyArray<FragmentSlotRegistrationMetadata>;
    }
  | { readonly success: false; readonly result: SchemaRegistrationResult };

export type ParsedSuccessfulRegistration = Extract<
  ParsedRegistration,
  { success: true }
>;

export function parseRegistrationRequest(
  request: SchemaRegistrationRequest,
): ParsedRegistration {
  try {
    if ("providerId" in request) return parseFragmentRegistration(request);
    return parseServiceRegistration(request);
  } catch (error: unknown) {
    return parsedValidationFailure(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseServiceRegistration(
  request: SchemaRegistrationRequest,
): ParsedRegistration {
  const parsed = serviceSchemaRegistrationRequestSchema.safeParse(request);
  if (!parsed.success)
    return parsedValidationFailure(firstIssueMessage(parsed.error));
  const data = parsed.data;
  const service = deriveServicePath(data.serviceId);
  const metadata: SchemaRegistrationMetadata = {
    ...service,
    environment: data.environment,
    providerId: data.serviceId,
    owner: data.owner,
    ...(data.schemaVersion ? { schemaVersion: data.schemaVersion } : {}),
  };
  return {
    success: true,
    kind: "service",
    schema: structuredClone(data.schema),
    environment: data.environment,
    metadata,
    targetPath: service.servicePath,
    slots: deriveSlotMetadata(data, service.servicePath),
  };
}

function deriveSlotMetadata(
  request: Extract<SchemaRegistrationRequest, { fragmentSlots: unknown }>,
  servicePath: string,
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
    };
  });
}

function parseFragmentRegistration(
  request: SchemaRegistrationRequest,
): ParsedRegistration {
  const parsed = fragmentSchemaRegistrationRequestSchema.safeParse(request);
  if (!parsed.success)
    return parsedValidationFailure(firstIssueMessage(parsed.error));
  const data = parsed.data;
  const derived = deriveFragmentPath(
    data.serviceId,
    data.slotPath,
    data.providerId,
  );
  return {
    success: true,
    kind: "fragment",
    schema: structuredClone(data.schema),
    environment: data.environment,
    metadata: {
      ...derived,
      environment: data.environment,
      owner: data.owner,
      ...(data.schemaVersion ? { schemaVersion: data.schemaVersion } : {}),
    },
    targetPath: derived.fragmentPath,
    slots: [],
  };
}

function parsedValidationFailure(message: string): ParsedRegistration {
  return { success: false, result: validationFailure(message) };
}

export function validationFailure(message: string): SchemaRegistrationResult {
  return {
    success: false,
    isNewSchema: false,
    hasBreakingChanges: false,
    error: createWeaverError("VALIDATION_ERROR", message),
  };
}

function firstIssueMessage(error: {
  readonly issues: readonly { readonly message: string }[];
}): string {
  return error.issues[0]?.message ?? "Invalid schema registration request";
}
