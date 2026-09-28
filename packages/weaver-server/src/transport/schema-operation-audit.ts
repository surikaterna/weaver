import {
  deriveFragmentPath,
  deriveServicePath,
  type SchemaValidationResult,
} from "@weaver-conf/config-engine";
import type {
  FragmentSchemaRegistrationRequest,
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

export function scompSchemaRegistrationContext(): SchemaRegistrationContext {
  return schemaRegistrationPersistenceContext(scompSchemaAuditIdentity());
}

export function schemaRegistrationAuditOutcome(
  result: SchemaRegistrationResponse,
): SchemaAuditOutcome {
  return {
    success: result.success,
    ...(!result.success
      ? { error: result.error?.message ?? "Schema registration failed" }
      : {}),
  };
}

export function schemaWriteAuditOutcome(
  result: WriteResult,
  fallback: string,
): SchemaAuditOutcome {
  return {
    success: result.success,
    ...(result.error?.message
      ? { error: result.error.message }
      : result.success
        ? {}
        : { error: fallback }),
  };
}

export function effectiveValidationAuditOutcome(
  result: SchemaValidationResult,
): SchemaAuditOutcome {
  return {
    success: result.valid,
    ...(result.valid
      ? {}
      : { error: "Registered effective validation failed" }),
  };
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
