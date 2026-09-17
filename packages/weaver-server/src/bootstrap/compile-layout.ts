import { compileInternalLayout } from "@weaver-conf/config-engine";
import {
  type BootstrapSeed,
  canonicalInternalJson,
  createWeaverError,
  type InternalInfrastructureGeneration,
  type InternalProviderDefinition,
  internalInfrastructureGenerationSchema,
  type ScopeInventory,
} from "@weaver-conf/config-types";
import {
  createProviderResource,
  disposeProviderResources,
  type ProviderFactories,
  type ProviderResource,
} from "./provider-resources";
import { type BootstrapCredentials, credential } from "./seed-trust";

export const CONTROL_LAYER = "control";
export function seedProviderDefinition(
  seed: BootstrapSeed,
): InternalProviderDefinition {
  const store = seed.store;
  if (store.factory === "fs")
    return { id: CONTROL_LAYER, factory: "fs", options: store.locator };
  if (store.factory === "mongodb")
    return {
      id: CONTROL_LAYER,
      factory: "mongodb",
      options: {
        database: store.locator.database,
        collection: store.locator.collection,
      },
      credentials: { connection: store.locator.connectionRef },
    };
  return {
    id: CONTROL_LAYER,
    factory: "git",
    options: {
      localPath: store.locator.localPath,
      filePath: store.locator.filePath,
      authority: "local-durable",
      ...(store.locator.remote ? { remote: store.locator.remote } : {}),
      ...(store.locator.branch ? { branch: store.locator.branch } : {}),
    },
    ...(store.credentialRefs
      ? { credentials: { token: store.credentialRefs.token } }
      : {}),
  };
}
export function compileBootstrapLayout(
  seed: BootstrapSeed,
  input: unknown,
  factories: ProviderFactories,
): InternalInfrastructureGeneration {
  const result = internalInfrastructureGenerationSchema.safeParse(input);
  if (!result.success)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid infrastructure generation",
      { issues: result.error.issues },
    );
  const generation = result.data;
  const control = generation.providers.find(
    (provider) => provider.id === CONTROL_LAYER,
  );
  if (
    canonicalInternalJson(control ?? null) !==
    canonicalInternalJson(seedProviderDefinition(seed))
  )
    throw createWeaverError(
      "FORBIDDEN",
      "The graph cannot relocate or replace the seed control store",
    );
  if (
    new Set(generation.layout.layers.map((layer) => layer.providerId)).size !==
      generation.providers.length ||
    generation.layout.layers.length !== generation.providers.length
  )
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Each installed provider requires exactly one layer binding",
    );
  assertInstalledLayers(generation, factories);
  compileInternalLayout(generation.layout);
  return generation;
}

function assertInstalledLayers(
  generation: InternalInfrastructureGeneration,
  factories: ProviderFactories,
): void {
  for (const layer of generation.layout.layers) {
    const definition = generation.providers.find(
      (provider) => provider.id === layer.providerId,
    );
    if (
      !definition ||
      !factories.get(definition.factory)?.schema.safeParse(definition).success
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Missing factory or unsupported provider options",
      );
    if (
      definition.factory === "memory" ||
      !["static", "dynamic"].includes(layer.type)
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Standalone infrastructure requires durable static/dynamic providers",
      );
    if (
      layer.providerId === CONTROL_LAYER &&
      (layer.name !== CONTROL_LAYER || layer.type !== "static")
    )
      throw createWeaverError(
        "FORBIDDEN",
        "Seed control binding must be static control",
      );
    if (
      layer.type === "dynamic" &&
      (layer.config.scopeIds.length !== 1 ||
        layer.config.scopeIds[0] !== layer.name)
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "A dynamic layer must bind its single named dimension",
      );
  }
}
export function physicalLayers(
  generation: InternalInfrastructureGeneration,
  providerId: string,
  inventory: ScopeInventory,
): string[] {
  const layer = generation.layout.layers.find(
    (entry) => entry.providerId === providerId,
  );
  if (!layer)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Provider layer binding is missing",
    );
  const keys = new Set([layer.name]);
  if (layer.type !== "dynamic") return [...keys];
  const scopes = Object.values(inventory.contexts).flatMap(
    (context) => context.scopePath,
  );
  for (const scope of scopes)
    if (scope.scopeId === layer.name)
      keys.add(`${scope.scopeId}:${scope.value}`);
  return [...keys].sort();
}
export async function resolveGenerationCredentials(
  generation: InternalInfrastructureGeneration,
  credentials: BootstrapCredentials,
): Promise<string> {
  for (const provider of generation.providers) {
    if (provider.factory === "mongodb")
      await credential(credentials, provider.credentials.connection);
    if (provider.factory === "git" && provider.credentials?.token)
      await credential(credentials, provider.credentials.token);
  }
  const auth = await credential(
    credentials,
    generation.server.auth.credentialRef,
  );
  if (auth.length < 32)
    throw createWeaverError(
      "UNAUTHORIZED",
      "Server authentication requires a strong injected credential",
    );
  return auth;
}
export async function instantiateGeneration(
  seed: BootstrapSeed,
  generation: InternalInfrastructureGeneration,
  inventory: ScopeInventory,
  credentials: BootstrapCredentials,
  factories: ProviderFactories,
  initialize: boolean,
  control: ProviderResource,
): Promise<ProviderResource[]> {
  const resources = [control];
  try {
    for (const layer of generation.layout.layers) {
      if (layer.providerId === CONTROL_LAYER) continue;
      const definition = generation.providers.find(
        (provider) => provider.id === layer.providerId,
      );
      if (!definition)
        throw createWeaverError("VALIDATION_ERROR", "Missing provider binding");
      resources.push(
        await createProviderResource(
          definition,
          {
            environment: seed.environment,
            layer: layer.name,
            physicalLayers: physicalLayers(
              generation,
              definition.id,
              inventory,
            ),
            initialize,
            credentials,
          },
          factories,
        ),
      );
    }
    return resources;
  } catch (error) {
    await disposeProviderResources(resources.slice(1), error);
    throw error;
  }
}
