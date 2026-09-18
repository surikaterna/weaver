import { createScompService } from "@scompr/core";
import {
  registeredEffectiveValidationRequestSchema,
  registeredEffectiveValidationResponseSchema,
  registeredObjectWriteRequestSchema,
  registeredObjectWriteResponseSchema,
  registeredPathPatchRequestSchema,
  registeredPathPatchResponseSchema,
  registeredSchemasResponseSchema,
} from "@weaver-conf/config-types";
import {
  WeaverConfig,
  type WeaverConfigContract,
} from "@weaver-conf/transport-scomp";
import type {
  EffectiveValidationContext,
  WeaverConfigService,
  WriteContext,
} from "../core/config-service-types";
import type { SchemaRegistry } from "../core/schema-registry";
import type { ScopeManager } from "../core/scope-manager";
import { parseScopeQuery } from "../core/scope-utils";
import type { ConfigDelta } from "../types/index";

export interface ScompServiceDeps {
  configService: WeaverConfigService;
  scopeManager: ScopeManager;
  schemaRegistry: SchemaRegistry;
}

export function createWeaverScompService(deps: ScompServiceDeps) {
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
      return schemaRegistry.register(input);
    },
  };
}

function registeredWriteHandlers(
  deps: ScompServiceDeps,
): Pick<WeaverConfigContract, "setRegisteredObject" | "patchRegisteredPath"> {
  const { configService, schemaRegistry } = deps;
  return {
    async setRegisteredObject(input) {
      const request = registeredObjectWriteRequestSchema.parse(input);
      const writeOpts: WriteContext = {
        ...(request.environment ? { environment: request.environment } : {}),
        ...(request.ifRevision ? { expectedRevision: request.ifRevision } : {}),
      };
      const response = await configService.setRegisteredObject(
        request.layer ?? "platform",
        request.anchorPath,
        request.value,
        { ...writeOpts, schemaRegistry },
      );
      return registeredObjectWriteResponseSchema.parse(response);
    },

    async patchRegisteredPath(input) {
      const request = registeredPathPatchRequestSchema.parse(input);
      const writeOpts: WriteContext = {
        ...(request.environment ? { environment: request.environment } : {}),
        ...(request.ifRevision ? { expectedRevision: request.ifRevision } : {}),
      };
      const response = await configService.patchRegisteredPath(
        request.layer ?? "platform",
        request.path,
        request.value,
        { ...writeOpts, schemaRegistry },
      );
      return registeredPathPatchResponseSchema.parse(response);
    },
  };
}

function registeredValidationHandler(
  deps: ScompServiceDeps,
): Pick<WeaverConfigContract, "validateRegisteredEffective"> {
  const { configService, schemaRegistry } = deps;
  return {
    async validateRegisteredEffective(input) {
      const request = registeredEffectiveValidationRequestSchema.parse(input);
      const scopePath = request.scope
        ? parseScopeQuery(request.scope)
        : undefined;
      const context: EffectiveValidationContext = {
        schemaRegistry,
        ...(request.environment ? { environment: request.environment } : {}),
        ...(scopePath ? { scopePath } : {}),
      };
      const response = await configService.validateRegisteredEffective(
        request.anchorPath,
        context,
      );
      return registeredEffectiveValidationResponseSchema.parse(response);
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
