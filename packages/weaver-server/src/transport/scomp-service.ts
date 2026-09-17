import { createScompService } from "@scompr/core";
import { WeaverConfig } from "@weaver-conf/transport-scomp";
import type {
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
  const { configService, scopeManager, schemaRegistry } = deps;
  return createScompService(WeaverConfig).implement({
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

    async listScopes(_input) {
      return { scopes: scopeManager.listScopes() };
    },

    async listScopeValues(input) {
      return { values: scopeManager.listScopeValues(input.scopeId) };
    },

    async fetchSchemas(_input) {
      return { schemas: schemaRegistry.listAll() };
    },

    async registerSchema(input) {
      return schemaRegistry.register(input);
    },

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
          if (queue.length > 0) {
            const next = queue.shift();
            if (next === undefined) continue;
            yield next;
          } else {
            await new Promise<void>((r) => {
              resolve = r;
            });
          }
        }
      } finally {
        unsub();
      }
    },
  });
}
