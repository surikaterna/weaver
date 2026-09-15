import {
  BUILTIN_CATALOG_REFERENCE,
  type ConfigurationStorageProvider,
  internalConfigurationSchema,
  internalRegistrationRecordSchema,
  type ObjectConfigurationPropertySchema,
  type ScopeDefinition,
  type ScopeInstance,
} from "@weaver-conf/config-types";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service";
import type { WeaverConfigServiceOptions } from "../src/core/config-service-types";
import { createControlService } from "../src/core/control-service";
import { scopeContextId } from "../src/core/scope-inventory";

/** Fixtures must declare their schemas and full contexts; never infer coverage from data. */
export async function createTestService(
  options: WeaverConfigServiceOptions,
  schemas: Readonly<Record<string, ObjectConfigurationPropertySchema>>,
  paths: readonly ScopeInstance[][] = [],
) {
  const prepared = await prepareTestService(options, schemas, paths);
  return createWeaverConfigService(prepared);
}

export async function prepareTestService(
  options: WeaverConfigServiceOptions,
  schemas: Readonly<Record<string, ObjectConfigurationPropertySchema>>,
  paths: readonly ScopeInstance[][] = [],
): Promise<WeaverConfigServiceOptions> {
  const control = createInMemoryStorageProvider({
    id: "test-control",
    layer: "control",
  });
  const providers = [control, ...options.providers];
  const configured = { ...options, providers, controlLayer: "control" };
  const bootstrap = await createControlService(configured);
  try {
    const records = Object.entries(schemas).map(([serviceId, schema]) =>
      internalRegistrationRecordSchema.parse({
        version: 1,
        kind: "service",
        audit: { actor: "fixture-owner" },
        request: {
          serviceId,
          schema,
          environment: options.environment,
          owner: { name: "fixture", contact: "fixture@example.com" },
          fragmentSlots: [],
        },
      }),
    );
    const scopes = new Map(
      paths.flatMap((path) =>
        path.map(
          (scope, index) =>
            [
              scope.scopeId,
              {
                id: scope.scopeId,
                label: scope.scopeId,
                ...(index
                  ? { parentScopeId: path[index - 1]?.scopeId ?? "" }
                  : {}),
              },
            ] as const,
        ),
      ),
    );
    const state = internalConfigurationSchema.parse({
      format: {
        version: 1,
        ...bootstrap.binding,
        initialization: "uninitialized",
        builtinCatalog: BUILTIN_CATALOG_REFERENCE,
      },
      catalog: { registrations: {} },
      infrastructure: {
        activeGeneration: "g1",
        generations: {
          g1: {
            version: 1,
            layout: {
              layers: providers.map((provider, index) =>
                fixtureLayer(provider, index, [...scopes.values()]),
              ),
              scopes: [...scopes.values()],
            },
            providers: providers.map((provider) => ({
              id: provider.id,
              factory: "memory",
              options: { durability: "volatile" },
            })),
            server: {
              port: 3399,
              auth: { credentialRef: "jwt", adminRoles: ["admin"] },
            },
          },
        },
      },
      scopeInventory: { version: 1, revision: "0", contexts: {} },
      upgrades: { plans: {}, journal: {} },
    });
    const result = await bootstrap.initialize(state);
    if (!result.success)
      throw new Error(
        `Fixture initialization failed: ${result.error?.message}`,
      );
    for (const record of records) {
      const result = await bootstrap.registerSchema(record.request);
      if (!result.success)
        throw new Error(
          `Fixture registration failed: ${result.error?.message}`,
        );
    }
    const inventory = options.scopeInventory ?? {
      version: 1 as const,
      revision: "0",
      contexts: Object.fromEntries(
        paths.map((scopePath) => [
          scopeContextId(scopePath),
          { scopePath, state: "active" as const },
        ]),
      ),
    };
    const inventoryResult = await bootstrap.initializeInventory(
      inventory,
      bootstrap.revision,
    );
    if (!inventoryResult.success)
      throw new Error(
        `Fixture scope initialization failed: ${inventoryResult.error?.message}`,
      );
    const finalized = await bootstrap.finalize(bootstrap.revision);
    if (!finalized.success)
      throw new Error(
        `Fixture finalization failed: ${finalized.error?.message}`,
      );
  } finally {
    await bootstrap.close();
  }
  return configured;
}

function fixtureLayer(
  provider: ConfigurationStorageProvider,
  index: number,
  scopes: readonly ScopeDefinition[],
) {
  const dimension = scopes.find(
    (scope) => scope.id === provider.layer.split(":")[0],
  );
  const scopeIds: string[] = [];
  let scope = dimension;
  while (scope) {
    scopeIds.unshift(scope.id);
    const parent = scope.parentScopeId;
    scope = scopes.find((item) => item.id === parent);
  }
  return {
    name: `layer${index}`,
    providerId: provider.id,
    type: dimension ? "dynamic" : "static",
    config: { mergeId: "deep", ...(dimension ? { scopeIds } : {}) },
  };
}
