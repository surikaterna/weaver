import {
  type BootstrapSeed,
  createWeaverError,
  type InitializeWeaverRequest,
} from "@weaver-conf/config-types";
import { getProviderRevision } from "@weaver-conf/storage-providers";
import { CONTROL_LAYER, seedProviderDefinition } from "./compile-layout";
import { assertSeedEntries, parseCurrentControl } from "./manifest";
import {
  assertResourceReferences,
  createProviderResource,
  type ProviderFactories,
  type ProviderResource,
} from "./provider-resources";
import { assertMatchingInitialization } from "./resume-intent";
import type { BootstrapCredentials } from "./seed-trust";

export function createSeedResource(
  seed: BootstrapSeed,
  credentials: BootstrapCredentials,
  factories: ProviderFactories,
  initialize: boolean,
): Promise<ProviderResource> {
  return createProviderResource(
    seedProviderDefinition(seed),
    {
      environment: seed.environment,
      layer: CONTROL_LAYER,
      physicalLayers: [CONTROL_LAYER],
      initialize,
      credentials,
    },
    factories,
  );
}
export async function inspectSeedResource(
  seed: BootstrapSeed,
  resource: ProviderResource,
  allowMaintenance: boolean,
) {
  const authority = resource.provider.authority;
  if (!authority)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Seed factory did not supply authority",
    );
  const envelope = await authority.readLayer(CONTROL_LAYER);
  if (
    seed.store.factory === "mongodb" &&
    envelope.storeId !== seed.store.locator.storeId
  )
    throw createWeaverError(
      "CONFIG_NOT_READY",
      "Mongo locator storeId does not match actual authority",
    );
  assertSeedEntries(envelope.entries);
  return {
    ...parseCurrentControl(
      envelope.entries._weaver,
      seed,
      { storeId: envelope.storeId, environment: seed.environment },
      allowMaintenance,
    ),
    controlRevision: getProviderRevision(envelope),
  };
}
export async function preflightFresh(
  seed: BootstrapSeed,
  resources: readonly ProviderResource[],
  input: InitializeWeaverRequest,
): Promise<boolean> {
  assertResourceReferences(resources);
  const namespaces: string[] = [];
  const control = resources.find(
    (resource) => resource.provider.id === CONTROL_LAYER,
  );
  if (!control?.provider.authority)
    throw createWeaverError("UNSUPPORTED_AUTHORITY", "Missing seed authority");
  const seedPlan = await control.provider.authority.preflight();
  const resume = seedPlan.initialization !== "fresh";
  if (resume)
    assertMatchingInitialization(
      (await inspectSeedResource(seed, control, true)).state,
      seed,
      input,
    );
  for (const resource of resources) {
    const plan = await preflightResource(
      resource,
      resource === control,
      resume,
      seed,
    );
    if (
      namespaces.some(
        (name) =>
          plan.namespace === name ||
          plan.namespace.startsWith(`${name}/`) ||
          name.startsWith(`${plan.namespace}/`),
      )
    )
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Provider namespaces overlap",
      );
    namespaces.push(plan.namespace);
  }
  return resume;
}

async function preflightResource(
  resource: ProviderResource,
  control: boolean,
  resume: boolean,
  seed: BootstrapSeed,
) {
  const authority = resource.provider.authority;
  if (authority?.capabilities.kind !== "durable-exclusive")
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "Fresh standalone targets require durable authority",
    );
  const plan = await authority.preflight();
  if (plan.initialization !== "fresh" && !resume)
    throw createWeaverError(
      "CONFIG_NOT_READY",
      "Initialization is new-target-only; existing stores are never reset or adopted",
    );
  if (resume && !control && plan.initialization !== "fresh")
    for (const layer of plan.layers) {
      if (Object.keys((await authority.readLayer(layer)).entries).length)
        throw createWeaverError(
          "CONFIG_NOT_READY",
          "Initialization cannot adopt populated application stores",
        );
    }
  if (
    control &&
    seed.store.factory === "mongodb" &&
    plan.namespace !== `${seed.store.locator.storeId}/${seed.environment}`
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Mongo seed storeId does not match its actual locator",
    );
  return plan;
}
