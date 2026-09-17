import type { ScopeDefinition } from "@weaver-conf/config-types";
import type { WeaverError } from "../types/errors";
import { createWeaverError } from "../types/errors";
import type { WeaverConfigService } from "./config-service";
import {
  removeInternalConfig,
  writeInternalConfig,
} from "./config-service-internal";
import type { SchemaRegistry } from "./schema-registry";
import { isSameScopeLayer, parseScopeLayer } from "./scope-utils";

export interface ProvisionScopeRequest {
  scopeId: string;
  value: string;
  displayName?: string;
  actor: string;
}

export interface DeprovisionScopeRequest {
  scopeId: string;
  value: string;
  archive?: boolean;
  actor: string;
}

export interface ScopeProvisionResult {
  success: boolean;
  scopeId: string;
  value: string;
  error?: WeaverError;
}

export interface ScopeManagerOptions {
  configService: WeaverConfigService;
  schemaRegistry: SchemaRegistry;
}

export interface ScopeManager {
  provision(request: ProvisionScopeRequest): Promise<ScopeProvisionResult>;
  deprovision(request: DeprovisionScopeRequest): Promise<ScopeProvisionResult>;
  listScopeValues(scopeId: string): string[];
  listScopes(): ScopeDefinition[];
}

export function createScopeManager(options: ScopeManagerOptions): ScopeManager {
  const { configService } = options;
  const activeScopes = new Map<string, Set<string>>();

  // Initialize from existing providers
  for (const provider of configService.providers) {
    const parsed = parseScopeLayer(provider.layer);
    if (parsed) {
      if (!activeScopes.has(parsed.scopeId)) {
        activeScopes.set(parsed.scopeId, new Set());
      }
      const values = activeScopes.get(parsed.scopeId);
      if (values === undefined) {
        throw new Error(`Scope set missing for ${parsed.scopeId}`);
      }
      values.add(parsed.value);
    }
  }

  return {
    async provision(
      request: ProvisionScopeRequest,
    ): Promise<ScopeProvisionResult> {
      const { scopeId, value, actor } = request;
      const existingValues = activeScopes.get(scopeId);

      if (existingValues?.has(value)) {
        return {
          success: false,
          scopeId,
          value,
          error: createWeaverError(
            "VALIDATION_ERROR",
            `Scope "${scopeId}:${value}" already exists`,
          ),
        };
      }

      const scopeLayer = `${scopeId}:${value}`;
      const provider = configService.providers.find(
        (p) =>
          p.layer === scopeLayer ||
          isSameScopeLayer(p.layer, scopeLayer) ||
          p.layer === scopeId,
      );
      if (provider) {
        await writeInternalConfig(
          configService,
          scopeLayer,
          `_weaver.scope.${scopeId}`,
          value,
          { environment: "default", actor },
        );
      }

      if (!activeScopes.has(scopeId)) {
        activeScopes.set(scopeId, new Set());
      }
      const updatedValues = activeScopes.get(scopeId);
      if (updatedValues === undefined) {
        throw new Error(`Scope set missing for ${scopeId}`);
      }
      updatedValues.add(value);
      return { success: true, scopeId, value };
    },

    async deprovision(
      request: DeprovisionScopeRequest,
    ): Promise<ScopeProvisionResult> {
      const { scopeId, value, actor } = request;
      const values = activeScopes.get(scopeId);

      if (!values?.has(value)) {
        return {
          success: false,
          scopeId,
          value,
          error: createWeaverError(
            "SCOPE_NOT_FOUND",
            `Scope "${scopeId}:${value}" not found`,
          ),
        };
      }

      const scopeLayer = `${scopeId}:${value}`;
      const provider = configService.providers.find(
        (p) => p.layer === scopeLayer || isSameScopeLayer(p.layer, scopeLayer),
      );
      await removeInternalConfig(
        configService,
        provider?.layer ?? scopeLayer,
        `_weaver.scope.${scopeId}`,
        {
          environment: "default",
          actor,
        },
      );

      values.delete(value);
      return { success: true, scopeId, value };
    },

    listScopeValues(scopeId: string): string[] {
      return [...(activeScopes.get(scopeId) ?? [])];
    },

    listScopes(): ScopeDefinition[] {
      const scopes: ScopeDefinition[] = [];
      for (const scopeId of activeScopes.keys()) {
        scopes.push({ id: scopeId, label: scopeId });
      }
      return scopes;
    },
  };
}
