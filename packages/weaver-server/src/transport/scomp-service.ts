import { createScompService } from "@scompr/core";
import { normalizeConfigPath } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  registeredEffectiveValidationRequestSchema,
  registeredEffectiveValidationResponseSchema,
  registeredObjectWriteRequestSchema,
  registeredObjectWriteResponseSchema,
  registeredPathPatchRequestSchema,
  registeredPathPatchResponseSchema,
  registeredSchemasResponseSchema,
  schemaRegistrationResponseSchema,
} from "@weaver-conf/config-types";
import {
  WeaverConfig,
  type WeaverConfigContract,
} from "@weaver-conf/transport-scomp";
import type { AuditService } from "../audit/audit-service";
import type {
  EffectiveValidationContext,
  WeaverConfigService,
  WriteContext,
} from "../core/config-service-types";
import type { SchemaRegistry } from "../core/schema-registry";
import type { ScopeManager } from "../core/scope-manager";
import { parseScopeQuery } from "../core/scope-utils";
import type { ConfigDelta } from "../types/index";
import {
  effectiveValidationAuditOutcome,
  schemaRegistrationAuditContext,
  schemaRegistrationAuditOutcome,
  schemaWriteAuditContext,
  schemaWriteAuditOutcome,
  scompSchemaAuditIdentity,
  scompSchemaRegistrationContext,
} from "./schema-operation-audit";
import { runSchemaOperation } from "./schema-operation-runner";

export interface ScompServiceDeps {
  configService: WeaverConfigService;
  scopeManager: ScopeManager;
  schemaRegistry: SchemaRegistry;
  auditService?: AuditService | undefined;
  defaultEnvironment: string;
}

export function createWeaverScompService(deps: ScompServiceDeps) {
  if (!deps.defaultEnvironment) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      "SCOMP defaultEnvironment must not be empty",
    );
  }
  return createScompService(WeaverConfig).implement({
    ...readHandlers(deps),
    ...writeHandlers(deps),
    ...scopeHandlers(deps),
    ...schemaHandlers(deps),
    ...registeredWriteHandlers(deps),
    ...registeredValidationHandler(deps),
    ...subscriptionHandler(deps),
  });
}

function readHandlers(
  deps: ScompServiceDeps,
): Pick<
  WeaverConfigContract,
  "resolveAll" | "get" | "getNamespace" | "inspect"
> {
  const { configService } = deps;
  return {
    async resolveAll(input) {
      const scopePath = input.scope ? parseScopeQuery(input.scope) : undefined;
      return configService.resolveAll(scopePath ? { scopePath } : undefined);
    },

    async get(input) {
      const scopePath = input.scope ? parseScopeQuery(input.scope) : undefined;
      const value = await configService.get(
        input.key,
        scopePath ? { scopePath } : undefined,
      );
      return { value };
    },

    async getNamespace(input) {
      const scopePath = input.scope ? parseScopeQuery(input.scope) : undefined;
      const entries = await configService.getNamespace(
        input.prefix,
        scopePath ? { scopePath } : undefined,
      );
      return { entries };
    },

    async inspect(input) {
      return configService.inspect(input.key);
    },
  };
}

function writeHandlers(
  deps: ScompServiceDeps,
): Pick<WeaverConfigContract, "set" | "setMany" | "remove"> {
  const { configService } = deps;
  return {
    async set(input) {
      const writeOpts: WriteContext = {
        ...(input.environment ? { environment: input.environment } : {}),
        ...(input.ifRevision ? { expectedRevision: input.ifRevision } : {}),
      };
      return configService.set(
        input.layer ?? "platform",
        input.key,
        input.value,
        writeOpts,
      );
    },

    async setMany(input) {
      const writeOpts: WriteContext = {
        ...(input.environment ? { environment: input.environment } : {}),
        ...(input.ifRevision ? { expectedRevision: input.ifRevision } : {}),
      };
      return configService.setMany(
        input.layer ?? "platform",
        input.entries,
        writeOpts,
      );
    },

    async remove(input) {
      const writeOpts: WriteContext = {
        ...(input.environment ? { environment: input.environment } : {}),
      };
      return configService.remove(
        input.layer ?? "platform",
        input.key,
        writeOpts,
      );
    },
  };
}

function scopeHandlers(
  deps: ScompServiceDeps,
): Pick<WeaverConfigContract, "listScopes" | "listScopeValues"> {
  const { scopeManager } = deps;
  return {
    async listScopes(_input) {
      return { scopes: scopeManager.listScopes() };
    },

    async listScopeValues(input) {
      return { values: scopeManager.listScopeValues(input.scopeId) };
    },
  };
}

function schemaHandlers(
  deps: ScompServiceDeps,
): Pick<WeaverConfigContract, "fetchSchemas" | "registerSchema"> {
  const { schemaRegistry } = deps;
  return {
    async fetchSchemas(_input) {
      return registeredSchemasResponseSchema.parse({
        schemas: schemaRegistry.listAll(),
      });
    },

    async registerSchema(input) {
      return runSchemaOperation({
        auditService: deps.auditService,
        context: schemaRegistrationAuditContext(
          input,
          scompSchemaAuditIdentity(),
        ),
        execute: () =>
          schemaRegistry.register(input, scompSchemaRegistrationContext()),
        parse: (response) => schemaRegistrationResponseSchema.parse(response),
        outcome: schemaRegistrationAuditOutcome,
      });
    },
  };
}

function registeredWriteHandlers(
  deps: ScompServiceDeps,
): Pick<WeaverConfigContract, "setRegisteredObject" | "patchRegisteredPath"> {
  return {
    ...registeredObjectWriteHandler(deps),
    ...registeredPathPatchHandler(deps),
  };
}

function registeredObjectWriteHandler(
  deps: ScompServiceDeps,
): Pick<WeaverConfigContract, "setRegisteredObject"> {
  const { configService, schemaRegistry } = deps;
  return {
    async setRegisteredObject(input) {
      const parsed = registeredObjectWriteRequestSchema.parse(input);
      const request = {
        ...parsed,
        anchorPath: normalizeConfigPath(parsed.anchorPath),
        environment: parsed.environment ?? deps.defaultEnvironment,
      };
      const writeOpts = registeredWriteOptions(request);
      return runSchemaOperation({
        auditService: deps.auditService,
        context: schemaWriteAuditContext(
          "schema.write.object",
          request.anchorPath,
          request.environment,
          scompSchemaAuditIdentity(),
        ),
        execute: () =>
          configService.setRegisteredObject(
            request.layer ?? "platform",
            request.anchorPath,
            request.value,
            { ...writeOpts, schemaRegistry },
          ),
        parse: (response) =>
          registeredObjectWriteResponseSchema.parse(response),
        outcome: (result) =>
          schemaWriteAuditOutcome(result, "Registered object write failed"),
      });
    },
  };
}

function registeredPathPatchHandler(
  deps: ScompServiceDeps,
): Pick<WeaverConfigContract, "patchRegisteredPath"> {
  const { configService, schemaRegistry } = deps;
  return {
    async patchRegisteredPath(input) {
      const parsed = registeredPathPatchRequestSchema.parse(input);
      const request = {
        ...parsed,
        path: normalizeConfigPath(parsed.path),
        environment: parsed.environment ?? deps.defaultEnvironment,
      };
      const writeOpts = registeredWriteOptions(request);
      return runSchemaOperation({
        auditService: deps.auditService,
        context: schemaWriteAuditContext(
          "schema.patch.path",
          request.path,
          request.environment,
          scompSchemaAuditIdentity(),
        ),
        execute: () =>
          configService.patchRegisteredPath(
            request.layer ?? "platform",
            request.path,
            request.value,
            { ...writeOpts, schemaRegistry },
          ),
        parse: (response) => registeredPathPatchResponseSchema.parse(response),
        outcome: (result) =>
          schemaWriteAuditOutcome(result, "Registered path patch failed"),
      });
    },
  };
}

function registeredWriteOptions(request: {
  readonly environment?: string | undefined;
  readonly ifRevision?: string | undefined;
}): WriteContext {
  return {
    ...(request.environment ? { environment: request.environment } : {}),
    ...(request.ifRevision ? { expectedRevision: request.ifRevision } : {}),
  };
}

function registeredValidationHandler(
  deps: ScompServiceDeps,
): Pick<WeaverConfigContract, "validateRegisteredEffective"> {
  const { configService, schemaRegistry } = deps;
  return {
    async validateRegisteredEffective(input) {
      const parsed = registeredEffectiveValidationRequestSchema.parse(input);
      const request = {
        ...parsed,
        anchorPath: normalizeConfigPath(parsed.anchorPath),
        environment: parsed.environment ?? deps.defaultEnvironment,
      };
      const scopePath = request.scope
        ? parseScopeQuery(request.scope)
        : undefined;
      const context: EffectiveValidationContext = {
        schemaRegistry,
        ...(request.environment ? { environment: request.environment } : {}),
        ...(scopePath ? { scopePath } : {}),
      };
      return runSchemaOperation({
        auditService: deps.auditService,
        context: schemaWriteAuditContext(
          "schema.validate.effective",
          request.anchorPath,
          request.environment,
          scompSchemaAuditIdentity(),
        ),
        execute: () =>
          configService.validateRegisteredEffective(
            request.anchorPath,
            context,
          ),
        parse: (response) =>
          registeredEffectiveValidationResponseSchema.parse(response),
        outcome: effectiveValidationAuditOutcome,
      });
    },
  };
}

function subscriptionHandler(
  deps: ScompServiceDeps,
): Pick<WeaverConfigContract, "subscribe"> {
  const { configService } = deps;
  return {
    async *subscribe(_input) {
      const queue: ConfigDelta[] = [];
      let resolve: (() => void) | null = null;

      const unsub = configService.onDelta((delta) => {
        queue.push(delta);
        if (resolve) {
          resolve();
          resolve = null;
        }
      });

      try {
        while (true) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      } finally {
        unsub();
      }
    },
  };
}
