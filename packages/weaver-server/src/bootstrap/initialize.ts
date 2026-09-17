import {
  runIndependentCleanup,
  type WeaverLogger,
} from "@weaver-conf/config-engine";
import type { SecretBackend } from "@weaver-conf/config-runtime";
import {
  createWeaverError,
  type InitializeWeaverRequest,
  initializeWeaverRequestSchema,
  WeaverErrorInstance,
  type WriteResult,
} from "@weaver-conf/config-types";
import { controlProjection } from "../core/config-service-internal";
import { createControlService } from "../core/control-service";
import {
  CONTROL_LAYER,
  compileBootstrapLayout,
  instantiateGeneration,
  resolveGenerationCredentials,
} from "./compile-layout";
import {
  installInitialRegistrations,
  orderInitialRegistrations,
} from "./initial-registrations";
import { initialConfiguration, validateInitializationInput } from "./manifest";
import {
  createBuiltinProviderFactories,
  disposeProviderResources,
  type ProviderFactories,
  type ProviderResource,
} from "./provider-resources";
import { assertMatchingInitialization } from "./resume-intent";
import { createSeedResource, preflightFresh } from "./seed-resource";
import {
  assertBootstrapAdministrator,
  type BootstrapAdministrator,
  type BootstrapCredentials,
  parseBootstrapSeed,
} from "./seed-trust";

export interface BootstrapRuntimeOptions {
  readonly credentials: BootstrapCredentials;
  readonly factories?: ProviderFactories;
  readonly secretBackend?: SecretBackend;
  readonly logger?: WeaverLogger;
}
export function assertWrite(result: WriteResult): void {
  if (!result.success)
    throw createWeaverError(
      result.error?.code === "COMMIT_OUTCOME_UNKNOWN"
        ? "COMMIT_OUTCOME_UNKNOWN"
        : "VALIDATION_ERROR",
      result.error?.message ?? "Control mutation failed",
      result.error?.details,
    );
}
export async function initializeWeaver(
  seedInput: unknown,
  input: unknown,
  administrator: BootstrapAdministrator,
  options: BootstrapRuntimeOptions,
): Promise<void> {
  const seed = parseBootstrapSeed(seedInput);
  assertBootstrapAdministrator(seed, administrator);
  const request = parseInitialization(input);
  const registrations = orderInitialRegistrations(request.registrations);
  const factories = options.factories ?? createBuiltinProviderFactories();
  const generation = compileBootstrapLayout(
    seed,
    request.generation,
    factories,
  );
  validateInitializationInput(seed, request);
  await resolveGenerationCredentials(generation, options.credentials);
  const control = await createSeedResource(
    seed,
    options.credentials,
    factories,
    true,
  );
  let resources: ProviderResource[] = [control];
  let failure: unknown;
  try {
    resources = await instantiateGeneration(
      seed,
      generation,
      request.scopeInventory,
      options.credentials,
      factories,
      true,
      control,
    );
    const resume = await preflightFresh(seed, resources, request);
    await writeIntent(seed, request, control, resume);
    await finishInitialization(
      seed.environment,
      request,
      registrations,
      resources,
    );
  } catch (error) {
    failure = error;
  }
  await disposeProviderResources(resources, failure);
}
function parseInitialization(input: unknown): InitializeWeaverRequest {
  try {
    const parsed = initializeWeaverRequestSchema.safeParse(input);
    if (!parsed.success)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Invalid initialization request",
        { issues: parsed.error.issues },
      );
    return initializeWeaverRequestSchema.parse(
      JSON.parse(JSON.stringify(parsed.data)),
    );
  } catch (error) {
    if (error instanceof WeaverErrorInstance) throw error;
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Initialization input must be valid JSON configuration",
    );
  }
}
async function writeIntent(
  seed: ReturnType<typeof parseBootstrapSeed>,
  request: InitializeWeaverRequest,
  resource: ProviderResource,
  resume: boolean,
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
    if (resume)
      assertMatchingInitialization(
        controlProjection(control.configuration).prepared().configuration,
        seed,
        request,
      );
    else
      assertWrite(
        await control.initialize(
          initialConfiguration(seed, request, control.binding),
        ),
      );
    assertWrite(
      await control.stageGeneration(
        request.generationId,
        request.generation,
        control.revision,
      ),
    );
  } catch (error) {
    failure = error;
  }
  await runIndependentCleanup(
    [{ name: "seed control service", run: () => control.close() }],
    failure,
  );
}
async function finishInitialization(
  environment: string,
  request: InitializeWeaverRequest,
  registrations: InitializeWeaverRequest["registrations"],
  resources: readonly ProviderResource[],
): Promise<void> {
  const control = await createControlService({
    providers: resources.map((resource) => resource.provider),
    environment,
    controlLayer: CONTROL_LAYER,
    controlPathsOnly: true,
    requireDurableAuthority: true,
  });
  let failure: unknown;
  try {
    assertWrite(
      await control.selectDraftGeneration(
        request.generationId,
        control.revision,
      ),
    );
    await installInitialRegistrations(control, registrations);
    assertWrite(
      await control.initializeInventory(
        request.scopeInventory,
        control.revision,
      ),
    );
    assertWrite(
      await control.activateGeneration(request.generationId, control.revision),
    );
    await control.application();
  } catch (error) {
    failure = error;
  }
  await runIndependentCleanup(
    [{ name: "initialization control service", run: () => control.close() }],
    failure,
  );
}
