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
import { assertConfigServiceTransportOpen } from "../core/config-service-lifecycle";
import type {
  EffectiveValidationContext,
  WeaverConfigService,
  WriteContext,
} from "../core/config-service-types";
import type { SchemaRegistry } from "../core/schema-registry";
import type { ScopeManager } from "../core/scope-manager";
import { parseScopeQuery } from "../core/scope-utils";
import { scompSubscriptionMethods } from "./scomp-subscription";

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
    ...scompSubscriptionMethods(deps),
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
      assertConfigServiceTransportOpen(configService);
      const scopePath = input.scope ? parseScopeQuery(input.scope) : undefined;
      return configService.resolveAll(scopePath ? { scopePath } : undefined);
    },

    async get(input) {
      assertConfigServiceTransportOpen(configService);
      const scopePath = input.scope ? parseScopeQuery(input.scope) : undefined;
      const value = await configService.get(
        input.key,
        scopePath ? { scopePath } : undefined,
      );
      return { value };
    },

    async getNamespace(input) {
      assertConfigServiceTransportOpen(configService);
      const scopePath = input.scope ? parseScopeQuery(input.scope) : undefined;
      const entries = await configService.getNamespace(
        input.prefix,
        scopePath ? { scopePath } : undefined,
      );
      return { entries };
    },

    async inspect(input) {
      assertConfigServiceTransportOpen(configService);
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
      assertConfigServiceTransportOpen(configService);
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
      assertConfigServiceTransportOpen(configService);
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
      assertConfigServiceTransportOpen(configService);
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
      assertConfigServiceTransportOpen(deps.configService);
      return { scopes: scopeManager.listScopes() };
    },

    async listScopeValues(input) {
      assertConfigServiceTransportOpen(deps.configService);
      return { values: scopeManager.listScopeValues(input.scopeId) };
    },

    async fetchSchemas(_input) {
      assertConfigServiceTransportOpen(deps.configService);
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
      assertConfigServiceTransportOpen(deps.configService);
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
      assertConfigServiceTransportOpen(configService);
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
      assertConfigServiceTransportOpen(configService);
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
      assertConfigServiceTransportOpen(configService);
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
