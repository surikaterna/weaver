import {
  deepEqual,
  deepGet,
  deepRemove,
  deepSet,
  parseCanonicalConfigPath,
} from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalUpgradePlan,
  type InternalUpgradeStep,
  internalUpgradeLayerDigest,
  internalUpgradeMutationSchema,
  sha256Hex,
} from "@weaver-conf/config-types";
import { hostForControl } from "./config-service-internal";
import type { WeaverConfigService } from "./config-service-types";
import { transitionDigest } from "./schema-transition";
import type { collectUpgradePlanningSnapshot } from "./upgrade-planning-snapshot";

type Snapshot = Awaited<ReturnType<typeof collectUpgradePlanningSnapshot>>;
type Layers = {
  readonly base: Map<string, Record<string, unknown>>;
  readonly scoped: Map<string, Record<string, unknown>>;
};

export async function assertInstalledPlanSemantics(
  service: WeaverConfigService,
  snapshot: Snapshot,
  expected: InternalUpgradePlan,
  installed: InternalUpgradePlan,
): Promise<void> {
  assertCanonicalSteps(installed);
  assertLogicalChanges(expected, installed);
  const expectedResult = await validateResult(service, snapshot, expected);
  const installedResult = await validateResult(service, snapshot, installed);
  if (!deepEqual(expectedResult.contexts, installedResult.contexts))
    fail("Installed plan changes delivered target semantics");
}

function assertLogicalChanges(
  expected: InternalUpgradePlan,
  installed: InternalUpgradePlan,
): void {
  const allowed = new Map<string, InternalUpgradeStep>();
  for (const step of expected.steps) {
    if (allowed.has(step.target.path))
      fail("Normal plan has conflicting paths");
    allowed.set(step.target.path, step);
  }
  const observed = new Set<string>();
  for (const step of installed.steps) {
    const expectedStep = allowed.get(step.target.path);
    if (
      !expectedStep ||
      observed.has(step.target.path) ||
      !deepEqual(step.mutation, expectedStep.mutation)
    )
      fail("Installed plan contains an unauthorized logical mutation");
    observed.add(step.target.path);
  }
  if (observed.size !== allowed.size)
    fail("Installed plan omits a required logical mutation");
}

async function validateResult(
  service: WeaverConfigService,
  snapshot: Snapshot,
  plan: InternalUpgradePlan,
) {
  const host = hostForControl(service);
  const layers = snapshotLayers(host, snapshot);
  for (const step of plan.steps) applyStep(layers, step, host);
  assertFinalDigests(plan, layers, host);
  const current = snapshot.configuration;
  const prepared = host.pipeline.contracts.prepare({
    ...current,
    catalog: plan.target.registrations
      ? { registrations: plan.target.registrations }
      : current.catalog,
  });
  return host.pipeline.validate(layers, prepared, plan.contexts);
}

function snapshotLayers(
  host: ReturnType<typeof hostForControl>,
  snapshot: Snapshot,
): Layers {
  const base = new Map<string, Record<string, unknown>>();
  const scoped = new Map<string, Record<string, unknown>>();
  for (const provider of snapshot.providers) {
    const admitted = host.providers.find(
      (item) => item.id === provider.providerId,
    );
    if (!admitted) fail("Installed plan provider is not admitted");
    for (const layer of provider.layers) {
      const target = layer.revision.layer === admitted.layer ? base : scoped;
      target.set(
        layer.revision.layer === admitted.layer
          ? admitted.id
          : layer.revision.layer,
        structuredClone(layer.entries),
      );
    }
  }
  return { base, scoped };
}

function applyStep(
  layers: Layers,
  step: InternalUpgradeStep,
  host: ReturnType<typeof hostForControl>,
): void {
  const provider = host.providers.find(
    (item) => item.id === step.target.providerId,
  );
  if (!provider || provider === host.pipeline.controlProvider)
    fail("Installed plan targets an unauthorized provider");
  const target =
    step.target.layer === provider.layer ? layers.base : layers.scoped;
  const id =
    step.target.layer === provider.layer ? provider.id : step.target.layer;
  const entries = target.get(id);
  if (!entries) fail("Installed plan target layer is unavailable");
  const key = parseCanonicalConfigPath(step.target.path).storageKey;
  const previous = structuredClone(deepGet(entries, key));
  if (step.preDigest !== valueDigest(previous))
    fail("Installed plan step prestate is stale");
  if (step.mutation.action === "remove") deepRemove(entries, key);
  else deepSet(entries, key, structuredClone(step.mutation.value));
  if (step.postDigest !== valueDigest(deepGet(entries, key)))
    fail("Installed plan step poststate is invalid");
  assertUndo(step, previous);
}

function assertCanonicalSteps(plan: InternalUpgradePlan): void {
  let previous = "";
  for (const step of plan.steps) {
    const order = canonicalInternalJson(step.target);
    const { id, ...body } = step;
    if (order <= previous || id !== `s${digest(body).slice(0, 31)}`)
      fail("Installed plan steps are not canonical");
    previous = order;
  }
}

function assertFinalDigests(
  plan: InternalUpgradePlan,
  layers: Layers,
  host: ReturnType<typeof hostForControl>,
) {
  for (const final of plan.finalLayers) {
    const provider = host.providers.find(
      (item) => item.id === final.providerId,
    );
    if (!provider) fail("Installed final provider is unavailable");
    const source = final.layer === provider.layer ? layers.base : layers.scoped;
    const entries = source.get(
      final.layer === provider.layer ? provider.id : final.layer,
    );
    if (
      !entries ||
      final.finalDigest !==
        internalUpgradeLayerDigest(entries, final.contentDomain)
    )
      fail("Installed plan final digest is invalid");
  }
}

function assertUndo(step: InternalUpgradeStep, previous: unknown): void {
  const expected = internalUpgradeMutationSchema.parse(
    previous === undefined
      ? { action: "remove" }
      : { action: "set", value: previous },
  );
  if (!step.reversible || !deepEqual(step.undo, expected))
    fail("Installed plan undo does not exactly restore prestate");
}

function valueDigest(value: unknown): string {
  return transitionDigest({
    absent: value === undefined,
    ...(value === undefined ? {} : { value }),
  });
}

function digest(value: unknown): string {
  return sha256Hex(canonicalInternalJson(value));
}

function fail(message: string): never {
  throw createWeaverError("VALIDATION_ERROR", message);
}
