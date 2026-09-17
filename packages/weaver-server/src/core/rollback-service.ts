import {
  createWeaverError,
  type RollbackRequest,
  rollbackRequestSchema,
  WeaverErrorInstance,
  type WriteResult,
} from "@weaver-conf/config-types";
import type { WeaverConfigService } from "./config-service-types";
import type { SchemaRegistry } from "./schema-registry";

export type { RollbackRequest } from "@weaver-conf/config-types";
export type RollbackResult = WriteResult;
export interface RollbackServiceOptions {
  readonly configService: WeaverConfigService;
  readonly schemaRegistry?: SchemaRegistry;
  /** Installed history reader returns a current-format anchor value, never an old-format conversion. */
  readonly resolveValue?: (request: RollbackRequest) => Promise<unknown>;
}
export interface RollbackService {
  rollback(request: RollbackRequest): Promise<RollbackResult>;
}

/** History restoration is an ordinary conditional validated mutation, never a Git reset plus reload. */
export function createRollbackService(
  options: RollbackServiceOptions,
): RollbackService {
  return { rollback: (request) => rollback(options, request) };
}
async function rollback(
  options: RollbackServiceOptions,
  input: RollbackRequest,
): Promise<RollbackResult> {
  try {
    const request = rollbackRequestSchema.parse(input);
    if (!options.resolveValue || !options.schemaRegistry)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Rollback requires an installed current-format history reader and canonical registry",
      );
    const value = await options.resolveValue(request);
    if (value === undefined)
      throw createWeaverError("NOT_FOUND", "Historical anchor is unavailable");
    return await options.configService.setRegisteredObject(
      request.layer,
      request.anchorPath,
      value,
      {
        environment: request.environment,
        expectedRevision: request.expectedRevision,
        actor: request.actor,
        schemaRegistry: options.schemaRegistry,
      },
    );
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof WeaverErrorInstance
          ? error
          : createWeaverError(
              "VALIDATION_ERROR",
              "Invalid rollback request or historical value",
            ),
    };
  }
}
