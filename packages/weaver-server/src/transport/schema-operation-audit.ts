import {
  deriveFragmentPath,
  deriveServicePath,
  type SchemaValidationResult,
} from "@weaver-conf/config-engine";
import type {
  FragmentSchemaRegistrationRequest,
  RegisteredEffectiveValidationRequest,
  RegisteredObjectWriteRequest,
  RegisteredPathPatchRequest,
  SchemaAuditAction,
  SchemaOperationAuditMetadata,
  SchemaRegistrationRequest,
  SchemaRegistrationResponse,
  ServiceSchemaRegistrationRequest,
  WriteResult,
} from "@weaver-conf/config-types";
import { schemaDomainAuditEntrySchema } from "@weaver-conf/config-types";
import type { AuditService } from "../audit/audit-service";
import type { AuthContext } from "../auth/auth-middleware";
import type { SchemaRegistrationContext } from "../core/schema-registry";
import type { RestRequest } from "./rest-adapter";

export interface SchemaAuditIdentity {
  readonly actor: string;
  readonly subject: string;
}

export interface SchemaAuditContext {
  readonly actor: string;
  readonly key: string;
  readonly environment: string;
  readonly metadata: SchemaOperationAuditMetadata;
}

export interface SchemaAuditOutcome {
  readonly success: boolean;
  readonly error?: string | undefined;
}

export function restSchemaAuditIdentity(
  authContext: AuthContext | undefined,
): SchemaAuditIdentity {
  const identity = authContext?.identity;
  const subject = identity?.serviceId ?? identity?.userId ?? "rest:anonymous";
  return { actor: subject, subject };
}

export function scompSchemaAuditIdentity(): SchemaAuditIdentity {
  return { actor: "scomp:transport", subject: "scomp:transport" };
}

export function schemaRegistrationPersistenceContext(
  identity: SchemaAuditIdentity,
): SchemaRegistrationContext {
  return identity;
}

export function schemaRegistrationAuditContext(
  request: SchemaRegistrationRequest,
  identity: SchemaAuditIdentity,
): SchemaAuditContext {
  return "providerId" in request
    ? fragmentRegistrationContext(request, identity)
    : serviceRegistrationContext(request, identity);
}

export function schemaWriteAuditContext(
  operation: Extract<
    SchemaAuditAction,
    "schema.write.object" | "schema.patch.path" | "schema.validate.effective"
  >,
  path: string,
  environment: string,
  identity: SchemaAuditIdentity,
): SchemaAuditContext {
  const writePath = path;
  const serviceId = writePath.slice(1).split("/")[0];
  return {
    actor: identity.actor,
    key: writePath,
    environment,
    metadata: {
      operation,
      subject: identity.subject,
      serviceId,
      writePath,
      environment,
    },
  };
}

export async function recordSchemaAuditOutcome(
  auditService: AuditService | undefined,
  context: SchemaAuditContext,
  outcome: SchemaAuditOutcome,
): Promise<void> {
  if (!auditService) return;
  const entry = schemaDomainAuditEntrySchema.parse({
    domain: "schema",
    timestamp: new Date().toISOString(),
    actor: context.actor,
    action: context.metadata.operation,
    key: context.key,
    environment: context.environment,
    success: outcome.success,
    metadata: context.metadata,
    ...(outcome.error ? { error: outcome.error } : {}),
  });
  await auditService.record(entry);
}

export function restSchemaRegistrationContext(
  request: RestRequest,
): SchemaRegistrationContext {
  return schemaRegistrationPersistenceContext(
    restSchemaAuditIdentity(request.authContext),
  );
}

export function scompSchemaRegistrationContext(): SchemaRegistrationContext {
  return schemaRegistrationPersistenceContext(scompSchemaAuditIdentity());
}

export async function auditRestSchemaRegistration(
  auditService: AuditService | undefined,
  request: RestRequest,
  registration: SchemaRegistrationRequest,
  result: SchemaRegistrationResponse,
): Promise<void> {
  await auditRegistration(
    auditService,
    registration,
    result,
    restSchemaAuditIdentity(request.authContext),
  );
}

export async function auditScompSchemaRegistration(
  auditService: AuditService | undefined,
  request: SchemaRegistrationRequest,
  result: SchemaRegistrationResponse,
): Promise<void> {
  await auditRegistration(
    auditService,
    request,
    result,
    scompSchemaAuditIdentity(),
  );
}

export function auditRestObjectWrite(
  auditService: AuditService | undefined,
  request: RestRequest,
  operation: RegisteredObjectWriteRequest,
  result: WriteResult,
  defaultEnvironment: string,
): Promise<void> {
  return auditWrite(
    auditService,
    operation.anchorPath,
    operation.environment ?? defaultEnvironment,
    "schema.write.object",
    result,
    restSchemaAuditIdentity(request.authContext),
    "Registered object write failed",
  );
}

export function auditScompObjectWrite(
  auditService: AuditService | undefined,
  request: RegisteredObjectWriteRequest,
  result: WriteResult,
  defaultEnvironment: string,
): Promise<void> {
  return auditWrite(
    auditService,
    request.anchorPath,
    request.environment ?? defaultEnvironment,
    "schema.write.object",
    result,
    scompSchemaAuditIdentity(),
    "Registered object write failed",
  );
}

export function auditRestPathPatch(
  auditService: AuditService | undefined,
  request: RestRequest,
  operation: RegisteredPathPatchRequest,
  result: WriteResult,
  defaultEnvironment: string,
): Promise<void> {
  return auditWrite(
    auditService,
    operation.path,
    operation.environment ?? defaultEnvironment,
    "schema.patch.path",
    result,
    restSchemaAuditIdentity(request.authContext),
    "Registered path patch failed",
  );
}

export function auditScompPathPatch(
  auditService: AuditService | undefined,
  request: RegisteredPathPatchRequest,
  result: WriteResult,
  defaultEnvironment: string,
): Promise<void> {
  return auditWrite(
    auditService,
    request.path,
    request.environment ?? defaultEnvironment,
    "schema.patch.path",
    result,
    scompSchemaAuditIdentity(),
    "Registered path patch failed",
  );
}

export function auditRestEffectiveValidation(
  auditService: AuditService | undefined,
  request: RestRequest,
  operation: RegisteredEffectiveValidationRequest,
  result: SchemaValidationResult,
  defaultEnvironment: string,
): Promise<void> {
  return auditEffectiveValidation(
    auditService,
    operation,
    result,
    defaultEnvironment,
    restSchemaAuditIdentity(request.authContext),
  );
}

export function auditScompEffectiveValidation(
  auditService: AuditService | undefined,
  request: RegisteredEffectiveValidationRequest,
  result: SchemaValidationResult,
  defaultEnvironment: string,
): Promise<void> {
  return auditEffectiveValidation(
    auditService,
    request,
    result,
    defaultEnvironment,
    scompSchemaAuditIdentity(),
  );
}

async function auditRegistration(
  auditService: AuditService | undefined,
  request: SchemaRegistrationRequest,
  result: SchemaRegistrationResponse,
  identity: SchemaAuditIdentity,
): Promise<void> {
  const context = schemaRegistrationAuditContext(request, identity);
  await recordSchemaAuditOutcome(auditService, context, {
    success: result.success,
    ...(result.error?.message ? { error: result.error.message } : {}),
  });
}

async function auditWrite(
  auditService: AuditService | undefined,
  path: string,
  environment: string,
  action: "schema.write.object" | "schema.patch.path",
  result: WriteResult,
  identity: SchemaAuditIdentity,
  fallback: string,
): Promise<void> {
  const context = schemaWriteAuditContext(action, path, environment, identity);
  await recordSchemaAuditOutcome(auditService, context, {
    success: result.success,
    ...(result.error?.message
      ? { error: result.error.message }
      : result.success
        ? {}
        : { error: fallback }),
  });
}

async function auditEffectiveValidation(
  auditService: AuditService | undefined,
  request: RegisteredEffectiveValidationRequest,
  result: SchemaValidationResult,
  defaultEnvironment: string,
  identity: SchemaAuditIdentity,
): Promise<void> {
  const context = schemaWriteAuditContext(
    "schema.validate.effective",
    request.anchorPath,
    request.environment ?? defaultEnvironment,
    identity,
  );
  await recordSchemaAuditOutcome(auditService, context, {
    success: result.valid,
    ...(result.valid
      ? {}
      : { error: "Registered effective validation failed" }),
  });
}

function serviceRegistrationContext(
  request: ServiceSchemaRegistrationRequest,
  identity: SchemaAuditIdentity,
): SchemaAuditContext {
  const { servicePath } = deriveServicePath(request.serviceId);
  return {
    actor: identity.actor,
    key: servicePath,
    environment: request.environment,
    metadata: {
      operation: "schema.register.service",
      subject: identity.subject,
      serviceId: request.serviceId,
      providerId: request.serviceId,
      servicePath,
      environment: request.environment,
    },
  };
}

function fragmentRegistrationContext(
  request: FragmentSchemaRegistrationRequest,
  identity: SchemaAuditIdentity,
): SchemaAuditContext {
  const paths = deriveFragmentPath(
    request.serviceId,
    request.slotPath,
    request.providerId,
  );
  return {
    actor: identity.actor,
    key: paths.fragmentPath,
    environment: request.environment,
    metadata: {
      operation: "schema.register.fragment",
      subject: identity.subject,
      ...paths,
      environment: request.environment,
    },
  };
}
