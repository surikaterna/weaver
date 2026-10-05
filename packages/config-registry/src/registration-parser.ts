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
import { snapshotPlainData } from "./plain-data-graph";
import type {
  SchemaRegistrationContext,
  SchemaRegistrationResult,
} from "./registry-contracts";
import { schemaRegistrationContextSchema } from "./registry-contracts";

type GuardedRegistrationInput =
  | {
      readonly success: true;
      readonly request: SchemaRegistrationRequest;
      readonly context: SchemaRegistrationContext | undefined;
    }
  | { readonly success: false; readonly result: SchemaRegistrationResult };

export function guardRegistrationInput(
  request: unknown,
  context?: unknown,
  fallbackEnvironment?: string,
): GuardedRegistrationInput {
  const captured = snapshotPlainData(request);
  const capturedContext = snapshotPlainData(context);
  if (!captured.success || !capturedContext.success) {
    return {
      success: false,
      result: validationFailure("Expected plain registration data"),
    };
  }
  const parsedContext = schemaRegistrationContextSchema
    .optional()
    .safeParse(capturedContext.value);
  if (!parsedContext.success)
    return {
      success: false,
      result: validationFailure("Invalid schema registration context"),
    };
  const parsed = validateRequestSnapshot(captured.value, fallbackEnvironment);
  return parsed.success
    ? { success: true, request: parsed.data, context: parsedContext.data }
    : {
        success: false,
        result: validationFailure(firstIssueMessage(parsed.error)),
      };
}

function validateRequestSnapshot(value: unknown, fallbackEnvironment?: string) {
  const request = normalizeEnvironment(value, fallbackEnvironment);
  const fragment =
    request !== null && typeof request === "object" && "providerId" in request;
  return fragment
    ? fragmentSchemaRegistrationRequestSchema.safeParse(request)
    : serviceSchemaRegistrationRequestSchema.safeParse(request);
}

function normalizeEnvironment(
  value: unknown,
  fallbackEnvironment?: string,
): unknown {
  if (
    fallbackEnvironment === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return value;
  const environment = Object.getOwnPropertyDescriptor(
    value,
    "environment",
  )?.value;
  Object.defineProperty(value, "environment", {
    value: environment || fallbackEnvironment || "",
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return value;
}

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
    const input = guardRegistrationInput(request);
    if (!input.success) return { success: false, result: input.result };
    if ("providerId" in input.request)
      return parseFragmentRegistration(input.request);
    return parseServiceRegistration(input.request);
  } catch (error: unknown) {
    return parsedValidationFailure(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseServiceRegistration(
  data: Extract<SchemaRegistrationRequest, { fragmentSlots: unknown }>,
): ParsedRegistration {
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
  data: Extract<SchemaRegistrationRequest, { providerId: string }>,
): ParsedRegistration {
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
