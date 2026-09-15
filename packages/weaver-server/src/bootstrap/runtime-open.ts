import { runIndependentCleanup } from "@weaver-conf/config-engine";
import type { SecretBackend } from "@weaver-conf/config-runtime";
import {
  type BootstrapSeed,
  createWeaverError,
  type InternalConfiguration,
  type InternalInfrastructureGeneration,
  weaverInspectionSchema,
} from "@weaver-conf/config-types";
import { controlProjection } from "../core/config-service-internal";
import { createControlService } from "../core/control-service";
import {
  CONTROL_LAYER,
  compileBootstrapLayout,
  instantiateGeneration,
  resolveGenerationCredentials,
} from "./compile-layout";
import { withinBootstrapDeadline } from "./deadline";
import type { BootstrapRuntimeOptions } from "./initialize";
import { sameConfiguration } from "./manifest";
import {
  assertResourceReferences,
  createBuiltinProviderFactories,
  disposeProviderResources,
  type ProviderFactories,
  type ProviderResource,
} from "./provider-resources";
import { createSeedResource, inspectSeedResource } from "./seed-resource";
import { credential, parseBootstrapSeed } from "./seed-trust";

interface OpeningRuntime {
  readonly seed: BootstrapSeed;
  readonly options: BootstrapRuntimeOptions;
  readonly factories: ProviderFactories;
  readonly seedResource: ProviderResource;
  resources: ProviderResource[];
  control?: Awaited<ReturnType<typeof createControlService>>;
}

export async function openRuntimeResources(
  input: unknown,
  options: BootstrapRuntimeOptions,
) {
  const seed = parseBootstrapSeed(input);
  if (
    (await credential(options.credentials, seed.trust.adminCredentialRef))
      .length < 32
  )
    throw createWeaverError(
      "UNAUTHORIZED",
      "Weak seed administration credential",
    );
  const factories = options.factories ?? createBuiltinProviderFactories();
  const seedResource = await createSeedResource(
    seed,
    options.credentials,
    factories,
    false,
  );
  const opening: OpeningRuntime = {
    seed,
    options,
    factories,
    seedResource,
    resources: [seedResource],
  };
  try {
    return await compileRuntime(opening);
  } catch (error) {
    await runIndependentCleanup(
      [
        {
          name: "control owners",
          run: async () => {
            await opening.control?.close();
          },
        },
        {
          name: "provider resources",
          run: () => disposeProviderResources(opening.resources),
        },
      ],
      error,
    );
    throw error;
  }
}
async function compileRuntime(opening: OpeningRuntime) {
  const { seed, seedResource, factories, options } = opening;
  const initial = await inspectSeedResource(seed, seedResource, true);
  if (
    initial.incomplete &&
    !Object.values(initial.state.upgrades.journal).some(
      (journal) =>
        !["completed", "compensated", "restart-required"].includes(
          journal.phase,
        ),
    )
  )
    throw createWeaverError(
      "MAINTENANCE",
      "Initialization is incomplete and requires bootstrap recovery",
    );
  const generation = activeGeneration(initial.state);
  compileBootstrapLayout(seed, generation, factories);
  const jwtSecret = await resolveGenerationCredentials(
    generation,
    options.credentials,
  );
  await readThroughSeedControl(seed, seedResource, initial.state);
  opening.resources = await instantiateGeneration(
    seed,
    generation,
    initial.state.scopeInventory,
    options.credentials,
    factories,
    false,
    seedResource,
  );
  assertResourceReferences(opening.resources);
  return activateRuntime(
    opening,
    initial.state,
    generation,
    jwtSecret,
    initial.incomplete,
  );
}
async function activateRuntime(
  opening: OpeningRuntime,
  expected: InternalConfiguration,
  generation: InternalInfrastructureGeneration,
  jwtSecret: string,
  maintenance: boolean,
) {
  const { seed, options, factories, resources } = opening;
  const secretBackend = boundedSecrets(options.secretBackend);
  const control = await createControlService({
    providers: resources.map((resource) => resource.provider),
    environment: seed.environment,
    controlLayer: CONTROL_LAYER,
    controlPathsOnly: true,
    requireDurableAuthority: true,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(secretBackend ? { secretBackend } : {}),
  });
  opening.control = control;
  if (
    !sameConfiguration(
      controlProjection(control.configuration).prepared().configuration,
      expected,
    )
  )
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Control authority changed while compiling infrastructure",
    );
  if (!maintenance) await validateStoredSecrets(resources, options, expected);
  const configService = maintenance
    ? control.configuration
    : await control.application();
  return {
    seed,
    factories,
    resources,
    control,
    configService,
    generation,
    jwtSecret,
    options,
    maintenance,
  };
}
function boundedSecrets(backend?: SecretBackend): SecretBackend | undefined {
  return backend
    ? {
        resolve: (reference) =>
          withinBootstrapDeadline(() => backend.resolve(reference)),
      }
    : undefined;
}
async function readThroughSeedControl(
  seed: BootstrapSeed,
  resource: ProviderResource,
  state: InternalConfiguration,
): Promise<void> {
  const control = await createControlService({
    providers: [resource.provider],
    environment: seed.environment,
    controlLayer: CONTROL_LAYER,
    controlPathsOnly: true,
    requireDurableAuthority: true,
  });
  let failure: unknown;
  try {
    if (
      !sameConfiguration(
        controlProjection(control.configuration).prepared().configuration,
        state,
      )
    )
      throw createWeaverError(
        "REVISION_CONFLICT",
        "Seed authority changed after inspection",
      );
  } catch (error) {
    failure = error;
  }
  await runIndependentCleanup(
    [{ name: "seed control owners", run: () => control.close() }],
    failure,
  );
}
export function activeGeneration(state: InternalConfiguration) {
  const generation =
    state.infrastructure.generations[state.infrastructure.activeGeneration];
  if (!generation)
    throw createWeaverError(
      "CONFIG_NOT_READY",
      "Active infrastructure generation is missing",
    );
  return generation;
}
async function validateStoredSecrets(
  resources: readonly ProviderResource[],
  options: BootstrapRuntimeOptions,
  state: InternalConfiguration,
): Promise<void> {
  const active = new Set(
    Object.values(state.scopeInventory.contexts)
      .filter((context) => context.state === "active")
      .flatMap((context) =>
        context.scopePath.map((scope) => `${scope.scopeId}:${scope.value}`),
      ),
  );
  for (const resource of resources) {
    if (resource.provider.id === CONTROL_LAYER) continue;
    const authority = resource.provider.authority;
    if (!authority)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Missing provider authority",
      );
    for (const revision of (await authority.inventory()).revisions) {
      if (revision.layer.includes(":") && !active.has(revision.layer)) continue;
      await validateSecrets(
        (await authority.readLayer(revision.layer)).entries,
        options,
      );
    }
  }
}
async function validateSecrets(
  input: unknown,
  options: BootstrapRuntimeOptions,
): Promise<void> {
  const pending = [input];
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if ("_weaver" in value && value._weaver === "secret-ref") {
      const { secretReferenceSchema } = await import(
        "@weaver-conf/config-types"
      );
      const reference = secretReferenceSchema.parse(value);
      if (
        typeof (await withinBootstrapDeadline(() =>
          options.secretBackend?.resolve(reference),
        )) !== "string"
      )
        throw createWeaverError(
          "CONFIG_NOT_READY",
          "A stored secret reference is unavailable",
        );
    } else pending.push(...Object.values(value));
  }
}
export async function inspectWeaver(
  seedInput: unknown,
  options: BootstrapRuntimeOptions,
) {
  const seed = parseBootstrapSeed(seedInput);
  const resource = await createSeedResource(
    seed,
    options.credentials,
    options.factories ?? createBuiltinProviderFactories(),
    false,
  );
  try {
    const { state, incomplete, controlRevision } = await inspectSeedResource(
      seed,
      resource,
      true,
    );
    return weaverInspectionSchema.parse({
      environment: seed.environment,
      state: incomplete ? "maintenance" : "configured",
      activeGeneration: state.infrastructure.activeGeneration,
      initialization: state.format.initialization,
      controlRevision,
    });
  } finally {
    await disposeProviderResources([resource]);
  }
}
