import { createScompService } from "@scompr/core";
import {
  createWeaverError,
  registeredEffectiveValidationRequestSchema,
  registeredObjectWriteRequestSchema,
  registeredPathPatchRequestSchema,
  schemaRegistrationOperationSchema,
} from "@weaver-conf/config-types";
import {
  WeaverConfig,
  type WeaverConfigContract,
} from "@weaver-conf/transport-scomp";
import type { AuthContext } from "../auth/auth-middleware";
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
  /** Trusted per-request peer identity supplied by the hosting transport, never from input JSON. */
  getAuthContext?: () => AuthContext | undefined;
  /** Installed standalone admission/auth policy, evaluated for every configuration mutation. */
  authorizeMutation?: () => void;
  /** Ends active subscriptions when maintenance closes application publication. */
  onMaintenance?: (listener: () => void) => () => void;
}

export function createWeaverScompService(deps: ScompServiceDeps) {
  return createScompService(WeaverConfig).implement({
    ...readMethods(deps),
    ...writeMethods(deps),
    ...scopeMethods(deps),
    ...registrationMethods(deps),
    ...objectMethods(deps),
    ...patchMethods(deps),
    ...validationMethods(deps),
    ...subscriptionMethods(deps),
  });
}

function readMethods({
  configService,
}: ScompServiceDeps): Pick<
  WeaverConfigContract,
  "resolveAll" | "get" | "getNamespace" | "inspect"
> {
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

function writeMethods({
  configService,
  authorizeMutation,
}: ScompServiceDeps): Pick<WeaverConfigContract, "set" | "setMany" | "remove"> {
  return {
    async set(input) {
      authorizeMutation?.();
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
      authorizeMutation?.();
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
      authorizeMutation?.();
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

function scopeMethods(
  deps: ScompServiceDeps,
): Pick<
  WeaverConfigContract,
  "listScopes" | "listScopeValues" | "fetchSchemas"
> {
  const { scopeManager, schemaRegistry } = deps;
  return {
    async listScopes(_input) {
      return { scopes: scopeManager.listScopes() };
    },

    async listScopeValues(input) {
      return { values: scopeManager.listScopeValues(input.scopeId) };
    },

    async fetchSchemas(_input) {
      if (!deps.getAuthContext?.()?.isAdmin)
        throw createWeaverError("FORBIDDEN", "Admin access required");
      return { schemas: schemaRegistry.listAll() };
    },
  };
}

function registrationMethods(
  deps: ScompServiceDeps,
): Pick<WeaverConfigContract, "registerSchema"> {
  const { schemaRegistry } = deps;
  return {
    async registerSchema(input) {
      deps.authorizeMutation?.();
      const auth = deps.getAuthContext?.();
      if (!auth?.isAdmin)
        return {
          success: false,
          isNewSchema: false,
          hasBreakingChanges: false,
          error: createWeaverError("FORBIDDEN", "Admin access required"),
        };
      const parsed = schemaRegistrationOperationSchema.safeParse(input);
      if (!parsed.success)
        return {
          success: false,
          isNewSchema: false,
          hasBreakingChanges: false,
          error: createWeaverError(
            "VALIDATION_ERROR",
            "Invalid registration request",
          ),
        };
      const { ifRevision, ...request } = parsed.data;
      return schemaRegistry.register(request, {
        ...(ifRevision ? { expectedRevision: ifRevision } : {}),
        actor: auth.identity.userId ?? auth.identity.serviceId ?? "admin",
      });
    },
  };
}

function objectMethods({
  configService,
  schemaRegistry,
  authorizeMutation,
}: ScompServiceDeps): Pick<WeaverConfigContract, "setRegisteredObject"> {
  return {
    async setRegisteredObject(input) {
      authorizeMutation?.();
      const request = registeredObjectWriteRequestSchema.parse(input);
      const writeOpts: WriteContext = {
        ...(request.environment ? { environment: request.environment } : {}),
        ...(request.ifRevision ? { expectedRevision: request.ifRevision } : {}),
      };
      return configService.setRegisteredObject(
        request.layer ?? "platform",
        request.anchorPath,
        request.value,
        {
          ...writeOpts,
          schemaRegistry,
        },
      );
    },
  };
}

function patchMethods({
  configService,
  schemaRegistry,
  authorizeMutation,
}: ScompServiceDeps): Pick<WeaverConfigContract, "patchRegisteredPath"> {
  return {
    async patchRegisteredPath(input) {
      authorizeMutation?.();
      const request = registeredPathPatchRequestSchema.parse(input);
      const writeOpts: WriteContext = {
        ...(request.environment ? { environment: request.environment } : {}),
        ...(request.ifRevision ? { expectedRevision: request.ifRevision } : {}),
      };
      return configService.patchRegisteredPath(
        request.layer ?? "platform",
        request.path,
        request.value,
        {
          ...writeOpts,
          schemaRegistry,
        },
      );
    },
  };
}

function validationMethods({
  configService,
  schemaRegistry,
}: ScompServiceDeps): Pick<
  WeaverConfigContract,
  "validateRegisteredEffective"
> {
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
      return configService.validateRegisteredEffective(
        request.anchorPath,
        context,
      );
    },
  };
}

function subscriptionMethods({
  configService,
  onMaintenance,
}: ScompServiceDeps): Pick<WeaverConfigContract, "subscribe"> {
  return {
    async *subscribe(_input) {
      const queue: ConfigDelta[] = [];
      let resolve: (() => void) | null = null;
      let stopped = false;
      const stop = onMaintenance?.(() => {
        stopped = true;
        queue.length = 0;
        resolve?.();
      });

      const unsub = configService.onDelta((delta) => {
        queue.push(delta);
        if (resolve) {
          resolve();
          resolve = null;
        }
      });

      try {
        while (!stopped) {
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
        stop?.();
        unsub();
      }
    },
  };
}
