import {
  canonicalInternalJson,
  containsRegistrationDefaultMarker,
  createWeaverError,
  type InternalUpgradePlannerInput,
  type InternalUpgradePlanResult,
  type InternalUpgradeRefusal,
  internalUpgradeLayerDigest,
  internalUpgradePlannerInputSchema,
  internalUpgradePlanResultSchema,
  sha256Hex,
} from "@weaver-conf/config-types";
import { z } from "zod";
import { deepEqual } from "./deep-equal";
import { validateEffectiveConfiguration } from "./schema-validation";
import {
  infrastructureBindingsMatch,
  schemasMatchCatalog,
  validateUpgradeProviders,
} from "./upgrade-bindings";
import {
  digestValue,
  isRecord,
  replaceAtPath,
  upgradeLayerContentDomain,
} from "./upgrade-data";
import { collectUpgradeDefaults } from "./upgrade-diff";
import { effectiveAnchor, physicalLayers } from "./upgrade-physical";
import { placeUpgradeDefaults } from "./upgrade-placement";
export function buildUpgradePlan(
  input: InternalUpgradePlannerInput,
): InternalUpgradePlanResult {
  const parsed = internalUpgradePlannerInputSchema.parse(input);
  if (containsRawMarker(parsed))
    return blocked([
      {
        code: "unverifiable-secret",
        message:
          "Raw planner snapshots must not contain secret or mount markers",
      },
    ]);
  const bindingRefusals = validateBindings(parsed);
  if (bindingRefusals.length) return blocked(bindingRefusals);
  const diff = collectUpgradeDefaults(parsed);
  const schemaRefusals = removedSchemaRefusals(parsed);
  if (diff.refusals.length || schemaRefusals.length)
    return blocked([...diff.refusals, ...schemaRefusals]);
  const placement = placeUpgradeDefaults(parsed, diff.defaults);
  if (placement.refusals.length) return blocked(placement.refusals);
  const contexts = canonicalContexts(parsed);
  const validation = validateResult(parsed, placement.anchors, contexts);
  if (validation.length) return blocked(validation);
  const steps = placement.anchors
    .map(createStep)
    .sort((a, b) =>
      canonicalInternalJson(a.target).localeCompare(
        canonicalInternalJson(b.target),
      ),
    );
  const finalLayers = createFinalLayers(parsed, steps);
  const body: Omit<
    import("@weaver-conf/config-types").InternalUpgradePlan,
    "id"
  > = {
    version: 1,
    source: sourceBinding(parsed),
    target: parsed.request.target,
    contexts,
    steps,
    finalLayers,
    refusals: [],
  };
  return internalUpgradePlanResultSchema.parse({
    status: "ready",
    plan: { ...body, id: digest(body) },
  });
}
function createFinalLayers(
  input: InternalUpgradePlannerInput,
  steps: readonly import("@weaver-conf/config-types").InternalUpgradeStep[],
) {
  const layers = input.providers.flatMap((provider) =>
    provider.layers.map((layer) => ({
      providerId: provider.providerId,
      namespace: provider.namespace,
      layer: layer.revision.layer,
      revision: layer.revision,
      entries: structuredClone(layer.entries),
      contentDomain: upgradeLayerContentDomain(layer.entries),
    })),
  );
  const sourceDigests = new Map(
    layers.map((layer) => [
      layerIdentity(layer.providerId, layer.layer),
      internalUpgradeLayerDigest(layer.entries, layer.contentDomain),
    ]),
  );
  for (const step of steps) applyPlannedMutation(layers, step);
  return layers
    .map((layer) => ({
      providerId: layer.providerId,
      namespace: layer.namespace,
      storeId: layer.revision.storeId,
      environment: layer.revision.environment,
      layer: layer.layer,
      contentDomain: layer.contentDomain,
      sourceDigest:
        sourceDigests.get(layerIdentity(layer.providerId, layer.layer)) ??
        internalUpgradeLayerDigest(layer.entries, layer.contentDomain),
      finalDigest: internalUpgradeLayerDigest(
        layer.entries,
        layer.contentDomain,
      ),
    }))
    .sort((a, b) => layerSortKey(a).localeCompare(layerSortKey(b)));
}

function applyPlannedMutation(
  layers: {
    readonly providerId: string;
    readonly layer: string;
    readonly entries: Record<string, unknown>;
  }[],
  step: import("@weaver-conf/config-types").InternalUpgradeStep,
): void {
  const layer = layers.find(
    (item) =>
      item.providerId === step.target.providerId &&
      item.layer === step.target.layer,
  );
  if (!layer)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Planned upgrade layer is missing",
    );
  const path = step.target.path.slice(1).split("/");
  if (step.mutation.action === "set") {
    if (!replaceAtPath(layer.entries, path, step.mutation.value))
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Planned upgrade mutation is invalid",
      );
    return;
  }
  removeAtPath(layer.entries, path);
}

function removeAtPath(
  entries: Record<string, unknown>,
  path: readonly string[],
): void {
  let current = entries;
  for (const segment of path.slice(0, -1)) {
    const child = current[segment];
    if (!isRecord(child)) return;
    current = child;
  }
  const leaf = path.at(-1);
  if (leaf !== undefined) delete current[leaf];
}

function layerIdentity(providerId: string, layer: string): string {
  return canonicalInternalJson([providerId, layer]);
}

function layerSortKey(layer: {
  readonly providerId: string;
  readonly namespace: string;
  readonly storeId: string;
  readonly environment: string;
  readonly layer: string;
}): string {
  return canonicalInternalJson([
    layer.providerId,
    layer.namespace,
    layer.storeId,
    layer.environment,
    layer.layer,
  ]);
}

function containsRawMarker(input: InternalUpgradePlannerInput): boolean {
  return input.providers.some((provider) =>
    provider.layers.some((layer) =>
      Object.values(layer.entries).some(containsRegistrationDefaultMarker),
    ),
  );
}

function createStep(
  anchor: ReturnType<typeof placeUpgradeDefaults>["anchors"][number],
): import("@weaver-conf/config-types").InternalUpgradeStep {
  const after = z.json().parse(anchor.after);
  const mutation: import("@weaver-conf/config-types").InternalUpgradeMutation =
    {
      action: "set",
      value: after,
    };
  const undo: import("@weaver-conf/config-types").InternalUpgradeMutation =
    anchor.before === undefined
      ? { action: "remove" }
      : { action: "set", value: z.json().parse(anchor.before) };
  const content = {
    target: anchor.target,
    expectedRevision: anchor.revision,
    preDigest: digestValue(anchor.before, anchor.before === undefined),
    postDigest: digestValue(anchor.after),
    mutation,
    reversible: true,
    undo,
  };
  return { id: `s${digest(content).slice(0, 31)}`, ...content };
}

function validateBindings(
  input: InternalUpgradePlannerInput,
): InternalUpgradeRefusal[] {
  const schemas = schemasMatchCatalog(input);
  if (schemas === "invalid-default")
    return [
      {
        code: "invalid-default",
        message: "Target catalog contains a semantically invalid default",
      },
    ];
  if (!schemas)
    return [
      {
        code: "stale-binding",
        message: "Compiled schemas do not match the bound catalogs",
      },
    ];
  if (hasStaleRequestBinding(input))
    return [
      {
        code: "stale-binding",
        message:
          "Upgrade planning input does not match its requested authority bindings",
      },
    ];
  return validateUpgradeProviders(input);
}

function hasStaleRequestBinding(input: InternalUpgradePlannerInput): boolean {
  return (
    input.authorityRevision !== input.request.expectedAuthorityRevision ||
    input.sourceCatalogDigest !== input.request.sourceCatalogDigest ||
    digest(input.sourceCatalog) !== input.sourceCatalogDigest ||
    digest(input.targetCatalog) !== input.targetCatalogDigest ||
    input.targetCatalogDigest !== input.request.target.catalogDigest ||
    input.inventory.revision !== input.request.inventoryRevision ||
    input.infrastructureGenerationId !==
      input.request.infrastructureGeneration ||
    (input.request.target.infrastructureGeneration !== undefined &&
      input.request.target.infrastructureGeneration !==
        input.infrastructureGenerationId) ||
    !deepEqual(
      input.request.target.registrations,
      input.targetCatalog.registrations,
    ) ||
    !infrastructureBindingsMatch(input)
  );
}

function validateResult(
  input: InternalUpgradePlannerInput,
  anchors: ReturnType<typeof placeUpgradeDefaults>["anchors"],
  contexts: readonly (readonly import("@weaver-conf/config-types").ScopeInstance[])[],
): InternalUpgradeRefusal[] {
  const layers = physicalLayers(input).map((layer) => ({
    ...layer,
    entries: structuredClone(layer.entries),
  }));
  for (const anchor of anchors) {
    const failure = applyAnchor(layers, anchor);
    if (failure) return [failure];
  }
  for (const binding of input.schemas)
    for (const context of contexts) {
      if (!binding.target) continue;
      const value = effectiveAnchor(input, layers, context, binding.path);
      const target = validateEffectiveConfiguration(binding.target, value);
      if (!target.valid)
        return [
          {
            code: existingInvalid(binding, value)
              ? "explicit-disposition-required"
              : "invalid-default",
            message:
              "Target configuration is not valid after simulated placement",
            path: binding.path,
            context,
          },
        ];
    }
  return [];
}

function applyAnchor(
  layers: ReturnType<typeof physicalLayers>[number][],
  anchor: ReturnType<typeof placeUpgradeDefaults>["anchors"][number],
): InternalUpgradeRefusal | undefined {
  const layer = layers.find(
    (item) =>
      item.providerId === anchor.target.providerId &&
      item.layer === anchor.target.layer,
  );
  if (!layer)
    return {
      code: "ambiguous-placement",
      message: "Selected physical target disappeared",
      target: anchor.target,
    };
  const path = anchor.target.path.slice(1).split("/");
  if (!replaceAtPath(layer.entries, path, anchor.after))
    return {
      code: "unsafe-overwrite",
      message: "Invalid empty plan anchor",
      target: anchor.target,
    };
}

function existingInvalid(
  binding: InternalUpgradePlannerInput["schemas"][number],
  value: unknown,
): boolean {
  if (!binding.source || !binding.target) return false;
  return !validateEffectiveConfiguration(binding.target, value).valid;
}

function removedSchemaRefusals(input: InternalUpgradePlannerInput) {
  const refusals: InternalUpgradeRefusal[] = [];
  for (const binding of input.schemas)
    if (binding.source && !binding.target)
      refusals.push({
        code: "explicit-disposition-required",
        message:
          "Removing a governed anchor requires an explicit executor disposition",
        path: binding.path,
      });
  return refusals;
}

function sourceBinding(input: InternalUpgradePlannerInput) {
  const providers = [...input.providers].sort((a, b) =>
    a.providerId.localeCompare(b.providerId),
  );
  return {
    catalogDigest: input.sourceCatalogDigest,
    dataDigests: providers.flatMap((provider) =>
      [...provider.layers]
        .sort((a, b) => a.revision.layer.localeCompare(b.revision.layer))
        .map((layer) => ({
          providerId: provider.providerId,
          namespace: provider.namespace,
          storeId: layer.revision.storeId,
          layer: layer.revision.layer,
          contentDomain: upgradeLayerContentDomain(layer.entries),
          digest: internalUpgradeLayerDigest(
            layer.entries,
            upgradeLayerContentDomain(layer.entries),
          ),
        })),
    ),
    providerRevisions: providers.map((provider) => ({
      providerId: provider.providerId,
      revisions: [...provider.layers]
        .map((item) => item.revision)
        .sort((a, b) => a.layer.localeCompare(b.layer)),
    })),
    inventoryRevision: input.inventory.revision,
    infrastructureGeneration: input.infrastructureGenerationId,
  };
}

function canonicalContexts(input: InternalUpgradePlannerInput) {
  return [
    [],
    ...Object.values(input.inventory.contexts).map((entry) => entry.scopePath),
  ]
    .map((path) => [...path])
    .sort((a, b) =>
      canonicalInternalJson(a).localeCompare(canonicalInternalJson(b)),
    );
}

function blocked(
  refusals: readonly InternalUpgradeRefusal[],
): InternalUpgradePlanResult {
  return internalUpgradePlanResultSchema.parse({
    status: "blocked",
    refusals: [...refusals].sort((a, b) =>
      canonicalInternalJson(a).localeCompare(canonicalInternalJson(b)),
    ),
  });
}

function digest(value: unknown): string {
  return sha256Hex(canonicalInternalJson(value));
}
