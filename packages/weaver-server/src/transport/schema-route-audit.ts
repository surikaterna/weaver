import {
  deriveFragmentPath,
  deriveServicePath,
  parseCanonicalConfigPath,
} from "@weaver-conf/config-engine";
import type {
  FragmentSchemaRegistrationRequest,
  SchemaDomainAuditEntry,
  SchemaRegistrationRequest,
  ServiceSchemaRegistrationRequest,
  WriteResult,
} from "@weaver-conf/config-types";
import type { AuditService } from "../audit/audit-service";
import type {
  SchemaRegistrationContext,
  SchemaRegistrationResult,
} from "../core/schema-registry";
import type { RestRequest } from "./rest-adapter";

type SchemaOperationKind =
  | "schema.register.service"
  | "schema.register.fragment"
  | "schema.write.object"
  | "schema.patch.path"
  | "schema.validate.effective";

interface SchemaAuditContext {
  readonly operation: SchemaOperationKind;
  readonly subject?: string | undefined;
  readonly serviceId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly servicePath?: string | undefined;
  readonly canonicalSlotPath?: string | undefined;
  readonly fragmentPath?: string | undefined;
  readonly writePath?: string | undefined;
  readonly environment?: string | undefined;
}

export function schemaRegistrationRouteContext(
  req: RestRequest,
  body: SchemaRegistrationRequest,
): SchemaAuditContext {
  return "providerId" in body
    ? fragmentRegistrationContext(req, body)
    : serviceRegistrationContext(req, body);
}

export function schemaRegistrationRequestContext(
  req: RestRequest,
): SchemaRegistrationContext {
  const subject = subjectFromRequest(req);
  return {
    ...(subject ? { subject, actor: subject } : {}),
  };
}

export function registeredObjectWriteRouteContext(
  req: RestRequest,
  path: string,
): SchemaAuditContext {
  return writeContext(req, "schema.write.object", path, req.query.env);
}

export function registeredPathPatchRouteContext(
  req: RestRequest,
  path: string,
): SchemaAuditContext {
  return writeContext(req, "schema.patch.path", path, req.query.env);
}

export function effectiveValidationRouteContext(
  req: RestRequest,
  path: string,
  environment?: string | undefined,
): SchemaAuditContext {
  return writeContext(req, "schema.validate.effective", path, environment);
}

export async function auditSchemaRegistration(
  auditService: AuditService | undefined,
  operation: SchemaAuditContext,
  result: SchemaRegistrationResult,
): Promise<void> {
  await recordSchemaAuditEvent(
    auditService,
    operation,
    result.success,
    result.error?.message,
  );
}

export async function auditSchemaWrite(
  auditService: AuditService | undefined,
  operation: SchemaAuditContext,
  result: WriteResult,
  fallback: string,
): Promise<void> {
  await recordSchemaAuditEvent(
    auditService,
    operation,
    result.success,
    result.error?.message ?? (result.success ? undefined : fallback),
  );
}

export async function recordSchemaAuditEvent(
  auditService: AuditService | undefined,
  context: SchemaAuditContext | undefined,
  success: boolean,
  error?: string | undefined,
): Promise<void> {
  if (!auditService || !context) return;
  await auditService.record(toSchemaAuditEntry(context, success, error));
}

function toSchemaAuditEntry(
  context: SchemaAuditContext,
  success: boolean,
  error?: string | undefined,
): SchemaDomainAuditEntry {
  return {
    domain: "schema",
    timestamp: new Date().toISOString(),
    actor: context.subject ?? "anonymous",
    action: context.operation,
    key: auditKey(context),
    environment: context.environment ?? "",
    success,
    metadata: context,
    ...(error ? { error } : {}),
  };
}

function auditKey(context: SchemaAuditContext): string {
  return (
    context.fragmentPath ??
    context.canonicalSlotPath ??
    context.servicePath ??
    context.writePath ??
    ""
  );
}

function subjectFromRequest(req: RestRequest): string | undefined {
  const identity = req.authContext?.identity;
  return identity?.serviceId ?? identity?.userId;
}

function serviceRegistrationContext(
  req: RestRequest,
  body: ServiceSchemaRegistrationRequest,
): SchemaAuditContext {
  const { servicePath } = deriveServicePath(body.serviceId);
  return {
    operation: "schema.register.service",
    serviceId: body.serviceId,
    providerId: body.serviceId,
    servicePath,
    environment: body.environment,
    ...subjectProperty(req),
  };
}

function fragmentRegistrationContext(
  req: RestRequest,
  body: FragmentSchemaRegistrationRequest,
): SchemaAuditContext {
  const paths = deriveFragmentPath(
    body.serviceId,
    body.slotPath,
    body.providerId,
  );
  return {
    operation: "schema.register.fragment",
    ...paths,
    environment: body.environment,
    ...subjectProperty(req),
  };
}

function writeContext(
  req: RestRequest,
  operation: SchemaOperationKind,
  path: string,
  environment?: string,
): SchemaAuditContext {
  const writePath = parseCanonicalConfigPath(path).path;
  return {
    operation,
    writePath,
    serviceId: writePath.slice(1).split("/")[0],
    environment,
    ...subjectProperty(req),
  };
}

function subjectProperty(req: RestRequest): {
  readonly subject?: string | undefined;
} {
  const subject = subjectFromRequest(req);
  return subject ? { subject } : {};
}
