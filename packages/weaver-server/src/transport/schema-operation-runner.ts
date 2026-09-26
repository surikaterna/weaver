import type { z } from "zod";
import type { AuditService } from "../audit/audit-service";
import { restResponseParser } from "./rest-route-boundary";
import {
  recordSchemaAuditOutcome,
  type SchemaAuditContext,
  type SchemaAuditOutcome,
} from "./schema-operation-audit";

export interface SchemaOperationRunnerOptions<Result> {
  readonly auditService: AuditService | undefined;
  readonly context: SchemaAuditContext;
  readonly execute: () => Promise<unknown>;
  readonly parse: (value: unknown) => Result;
  readonly outcome: (result: Result) => SchemaAuditOutcome;
}

const unexpectedFailure: SchemaAuditOutcome = {
  success: false,
  error: "Schema operation failed unexpectedly",
};

const malformedResponse: SchemaAuditOutcome = {
  success: false,
  error: "Schema operation returned malformed response",
};

export async function runSchemaOperation<Result>(
  options: SchemaOperationRunnerOptions<Result>,
): Promise<Result> {
  let response: unknown;
  try {
    response = await options.execute();
  } catch (error) {
    return recordFailureAndRethrow(options, unexpectedFailure, error);
  }

  let result: Result;
  try {
    result = options.parse(response);
  } catch (error) {
    return recordFailureAndRethrow(options, malformedResponse, error);
  }

  await recordSchemaAuditOutcome(
    options.auditService,
    options.context,
    options.outcome(result),
  );
  return result;
}

export function runRestSchemaOperation<Schema extends z.ZodType>(
  auditService: AuditService | undefined,
  context: SchemaAuditContext,
  execute: () => Promise<unknown>,
  operation: string,
  schema: Schema,
  outcome: (result: z.output<Schema>) => SchemaAuditOutcome,
): Promise<z.output<Schema>> {
  return runSchemaOperation({
    auditService,
    context,
    execute,
    parse: restResponseParser(operation, schema),
    outcome,
  });
}

async function recordFailureAndRethrow(
  options: Pick<
    SchemaOperationRunnerOptions<unknown>,
    "auditService" | "context"
  >,
  outcome: SchemaAuditOutcome,
  error: unknown,
): Promise<never> {
  await recordSchemaAuditOutcome(
    options.auditService,
    options.context,
    outcome,
  ).catch(() => undefined);
  throw error;
}
