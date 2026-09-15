import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { runIndependentCleanup } from "@weaver-conf/config-engine";
import {
  type ConfigurationStorageProvider,
  createWeaverError,
  type InternalProviderDefinition,
  internalProviderDefinitionSchema,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import {
  createFileSystemStorageProvider,
  createGitManager,
  createGitStorageProvider,
  createInMemoryStorageProvider,
  createMongoDBStorageProvider,
} from "@weaver-conf/storage-providers";
import type { z } from "zod";
import { bindProviderDefinition } from "../core/provider-definition-binding";
import { type BootstrapCredentials, credential } from "./seed-trust";

export interface ProviderResource {
  readonly provider: ConfigurationStorageProvider;
  readonly checkout?: string;
  dispose(): Promise<void>;
}
export interface ProviderBuildContext {
  readonly environment: string;
  readonly layer: string;
  readonly physicalLayers: readonly string[];
  readonly initialize: boolean;
  readonly credentials: BootstrapCredentials;
}
/** Factories are installed code, never loaded by names/paths from stored JSON. */
export interface InstalledProviderFactory {
  readonly id: InternalProviderDefinition["factory"];
  readonly schema: z.ZodType<InternalProviderDefinition>;
  create(
    definition: InternalProviderDefinition,
    context: ProviderBuildContext,
  ): Promise<ProviderResource>;
}
export type ProviderFactories = ReadonlyMap<
  InternalProviderDefinition["factory"],
  InstalledProviderFactory
>;
export function createBuiltinProviderFactories(): ProviderFactories {
  const ids: InternalProviderDefinition["factory"][] = [
    "fs",
    "git",
    "mongodb",
    "memory",
  ];
  return new Map(
    ids.map((id) => [
      id,
      Object.freeze({
        id,
        schema: internalProviderDefinitionSchema.refine(
          (value) => value.factory === id,
        ),
        create: createResource,
      }),
    ]),
  );
}
export async function createProviderResource(
  definition: InternalProviderDefinition,
  context: ProviderBuildContext,
  factories: ProviderFactories,
): Promise<ProviderResource> {
  const factory = factories.get(definition.factory);
  if (!factory || factory.id !== definition.factory)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      `Factory is not installed: ${definition.factory}`,
    );
  const parsed = factory.schema.safeParse(definition);
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid provider options", {
      providerId: definition.id,
      issues: parsed.error.issues,
    });
  try {
    const resource = await factory.create(parsed.data, context);
    bindProviderDefinition(resource.provider, parsed.data);
    return resource;
  } catch (error) {
    if (error instanceof WeaverErrorInstance) throw error;
    throw createWeaverError(
      "PROVIDER_LOAD_FAILED",
      `Provider construction failed: ${definition.id}`,
    );
  }
}
async function createResource(
  definition: InternalProviderDefinition,
  context: ProviderBuildContext,
): Promise<ProviderResource> {
  const authority = {
    environment: context.environment,
    initialize: context.initialize,
    layers: [...context.physicalLayers],
  };
  const common = { id: definition.id, layer: context.layer, writable: true };
  if (definition.factory === "fs") {
    if (!isAbsolute(definition.options.filePath))
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Filesystem provider path must be absolute",
      );
    return {
      provider: createFileSystemStorageProvider({
        ...common,
        filePath: definition.options.filePath,
        authority,
      }),
      dispose: async () => {},
    };
  }
  if (definition.factory === "mongodb")
    return createMongoResource(definition, context);
  if (definition.factory === "git")
    return createGitResource(definition, context);
  return {
    provider: createInMemoryStorageProvider({
      id: definition.id,
      layer: context.layer,
      environment: context.environment,
    }),
    dispose: async () => {},
  };
}
async function createMongoResource(
  definition: Extract<InternalProviderDefinition, { factory: "mongodb" }>,
  context: ProviderBuildContext,
): Promise<ProviderResource> {
  const connection = await credential(
    context.credentials,
    definition.credentials.connection,
  );
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(connection, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 10_000,
  });
  try {
    await client.connect();
    const collection = client
      .db(definition.options.database)
      .collection(definition.options.collection);
    return {
      provider: createMongoDBStorageProvider({
        id: definition.id,
        layer: context.layer,
        environment: context.environment,
        collection,
        writable: true,
        authority: {
          client,
          initialize: context.initialize,
          layers: [...context.physicalLayers],
        },
      }),
      dispose: () => client.close(),
    };
  } catch {
    await runIndependentCleanup(
      [{ name: `Mongo client ${definition.id}`, run: () => client.close() }],
      createWeaverError(
        "PROVIDER_LOAD_FAILED",
        `Provider connection failed: ${definition.id}`,
      ),
    );
    throw createWeaverError(
      "PROVIDER_LOAD_FAILED",
      "Provider connection failed",
    );
  }
}
async function createGitResource(
  definition: Extract<InternalProviderDefinition, { factory: "git" }>,
  context: ProviderBuildContext,
): Promise<ProviderResource> {
  const { localPath, filePath, remote } = definition.options;
  const git = await openLocalCheckout(localPath, filePath);
  const token = definition.credentials?.token
    ? await credential(context.credentials, definition.credentials.token)
    : undefined;
  const manager = createGitManager({
    localPath,
    repoUrl: remote ?? "https://unused.invalid",
    ...(definition.options.branch ? { branch: definition.options.branch } : {}),
    ...(token ? { token } : {}),
    git,
  });
  const provider = createGitStorageProvider({
    id: definition.id,
    layer: context.layer,
    gitManager: manager,
    filePath,
    writable: true,
    replicate: remote !== undefined,
    authority: {
      environment: context.environment,
      initialize: context.initialize,
      layers: [...context.physicalLayers],
    },
  });
  return {
    provider,
    checkout: await realpath(localPath),
    dispose: async () => {},
  };
}

async function openLocalCheckout(localPath: string, filePath: string) {
  if (
    !isAbsolute(localPath) ||
    isAbsolute(filePath) ||
    filePath.split("/").includes("..")
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Git requires a persistent local checkout and relative data path",
    );
  const gitDirectory = await stat(join(localPath, ".git")).catch(
    () => undefined,
  );
  if (!gitDirectory)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Git authority requires an existing local checkout; remote cloning/adoption is unsupported",
    );
  const { simpleGit } = await import("simple-git");
  const git = simpleGit({ baseDir: localPath, timeout: { block: 10_000 } });
  if (!(await git.checkIsRepo()))
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Git locator is not a local repository",
    );
  return git;
}
export function assertResourceReferences(
  resources: readonly ProviderResource[],
): void {
  const checkouts = resources.flatMap((resource) =>
    resource.checkout ? [resource.checkout] : [],
  );
  if (new Set(checkouts).size !== checkouts.length)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Sharing a Git checkout across provider instances is unsupported",
    );
}
export async function disposeProviderResources(
  resources: readonly ProviderResource[],
  primary?: unknown,
): Promise<void> {
  await runIndependentCleanup(
    [...resources].reverse().map((resource) => ({
      name: `resource:${resource.provider.id}`,
      run: () => resource.dispose(),
    })),
    primary,
  );
}
