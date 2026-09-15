import type {
  ConfigurationPropertySchema,
  InternalUpgradePlannerInput,
  InternalUpgradeRefusal,
  InternalUpgradeTarget,
  ProviderRevision,
  ScopeInstance,
} from "@weaver-conf/config-types";
import { validateEffectiveConfiguration } from "./schema-validation";
import {
  canonicalUpgradeContexts,
  hasOwnPath,
  isRecord,
  setOwnPath,
  upgradePathSegments,
  valueAt,
} from "./upgrade-data";
import type { UpgradeDefault } from "./upgrade-diff";
import {
  chooseSharedLayer,
  effectiveAnchor,
  effectiveEntries,
  type PhysicalLayer,
  physicalLayers,
  visibleToContext,
} from "./upgrade-physical";
import { containsSensitiveValue } from "./upgrade-sensitive";

export interface PlannedAnchor {
  readonly target: InternalUpgradeTarget;
  readonly revision: ProviderRevision;
  readonly before: unknown;
  readonly after: unknown;
}
export function placeUpgradeDefaults(
  input: InternalUpgradePlannerInput,
  additions: readonly UpgradeDefault[],
): {
  readonly anchors: readonly PlannedAnchor[];
  readonly refusals: readonly InternalUpgradeRefusal[];
} {
  const physical = physicalLayers(input);
  const contexts = canonicalUpgradeContexts(input);
  const grouped = groupByAnchor(additions);
  const anchors: PlannedAnchor[] = [];
  const refusals: InternalUpgradeRefusal[] = [];
  for (const [anchor, defaults] of grouped) {
    const result = placeAnchor(input, physical, contexts, anchor, defaults);
    if ("code" in result) refusals.push(result);
    else if (result.anchor) anchors.push(result.anchor);
  }
  return { anchors, refusals };
}

function placeAnchor(
  input: InternalUpgradePlannerInput,
  physical: readonly PhysicalLayer[],
  contexts: readonly (readonly ScopeInstance[])[],
  anchor: string,
  defaults: readonly UpgradeDefault[],
): { readonly anchor?: PlannedAnchor } | InternalUpgradeRefusal {
  const affected = contexts.filter((context) =>
    defaults.some(
      (item) =>
        !hasOwnPath(
          effectiveAnchor(input, physical, context, anchor),
          item.path,
        ),
    ),
  );
  if (!affected.length) return {};
  if (hasExplicitNonObject(input, physical, affected, anchor))
    return unsafeAnchor(anchor);
  const layer = chooseSharedLayer(input, physical, affected);
  if (!layer)
    return {
      code: "ambiguous-placement",
      message:
        "No durable writable shared layer is visible to every affected context",
      path: anchor,
    };
  return prepareAnchor(
    input,
    physical,
    contexts,
    affected,
    layer,
    anchor,
    defaults,
  );
}

function prepareAnchor(
  input: InternalUpgradePlannerInput,
  physical: readonly PhysicalLayer[],
  contexts: readonly (readonly ScopeInstance[])[],
  affected: readonly (readonly ScopeInstance[])[],
  layer: PhysicalLayer,
  anchor: string,
  defaults: readonly UpgradeDefault[],
): { readonly anchor?: PlannedAnchor } | InternalUpgradeRefusal {
  const before = valueAt(layer.entries, upgradePathSegments(anchor));
  if (
    hasConflictingOwnValue(input, physical, contexts, layer, anchor, defaults)
  )
    return {
      code: "ambiguous-placement",
      message:
        "Shared placement would overwrite an existing higher-layer value",
      path: anchor,
    };
  if (before !== undefined && !isRecord(before)) return unsafeAnchor(anchor);
  const sensitive = defaults.some(
    (item) =>
      containsSensitiveValue(item.sourceRootSchema, before) ||
      containsSensitiveValue(item.rootSchema, before),
  );
  if (sensitive) return sensitiveRefusal(anchor);
  const existing = incompatibleContext(
    input,
    physical,
    contexts,
    anchor,
    defaults,
  );
  if (existing) return incompatibleRefusal(anchor, existing);
  const replacement = initialReplacement(before, defaults[0]?.rootSchema);
  if (!replacement)
    return {
      code: "missing-default",
      message: "An absent anchor requires an explicit complete object default",
      path: anchor,
    };
  if (!insertDefaults(input, physical, affected, anchor, defaults, replacement))
    return {
      code: "unsafe-overwrite",
      message: "Default insertion would replace an ancestor, clear, or array",
      path: anchor,
    };
  return { anchor: plannedAnchor(layer, anchor, before, replacement) };
}

function sensitiveRefusal(path: string): InternalUpgradeRefusal {
  return {
    code: "unverifiable-secret",
    message: "A full anchor replacement would serialize sensitive data",
    path,
  };
}

function incompatibleRefusal(
  path: string,
  context: readonly ScopeInstance[],
): InternalUpgradeRefusal {
  return {
    code: "explicit-disposition-required",
    message:
      "An existing governed value is incompatible with the target schema",
    path,
    context,
  };
}

function hasExplicitNonObject(
  input: InternalUpgradePlannerInput,
  physical: readonly PhysicalLayer[],
  contexts: readonly (readonly ScopeInstance[])[],
  anchor: string,
): boolean {
  const path = upgradePathSegments(anchor);
  return contexts.some((context) =>
    hasNonObjectPath(effectiveEntries(input, physical, context), path),
  );
}

function hasNonObjectPath(
  entries: Readonly<Record<string, unknown>>,
  path: readonly string[],
): boolean {
  let current: unknown = entries;
  for (const key of path) {
    if (!isRecord(current)) return true;
    if (!Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return !isRecord(current);
}

function incompatibleContext(
  input: InternalUpgradePlannerInput,
  physical: readonly PhysicalLayer[],
  contexts: readonly (readonly ScopeInstance[])[],
  anchor: string,
  defaults: readonly UpgradeDefault[],
): readonly ScopeInstance[] | undefined {
  return contexts.find((context) => {
    const value = effectiveAnchor(input, physical, context, anchor);
    return defaults.some(
      (item) =>
        hasOwnPath(value, item.path) &&
        !validateEffectiveConfiguration(item.schema, valueAt(value, item.path))
          .valid,
    );
  });
}

function hasConflictingOwnValue(
  input: InternalUpgradePlannerInput,
  physical: readonly PhysicalLayer[],
  contexts: readonly (readonly ScopeInstance[])[],
  target: PhysicalLayer,
  anchor: string,
  defaults: readonly UpgradeDefault[],
): boolean {
  return contexts.some((context) =>
    physical
      .filter(
        (layer) =>
          layer.rank > target.rank && visibleToContext(input, layer, context),
      )
      .some((layer) => {
        const value = valueAt(layer.entries, upgradePathSegments(anchor));
        return defaults.some((item) => hasOwnPath(value, item.path));
      }),
  );
}

function unsafeAnchor(path: string): InternalUpgradeRefusal {
  return {
    code: "unsafe-overwrite",
    message: "An explicit anchor clear, scalar, or array cannot be replaced",
    path,
  };
}

function initialReplacement(
  before: unknown,
  root: ConfigurationPropertySchema | undefined,
): Record<string, unknown> | undefined {
  if (isRecord(before)) return structuredClone(before);
  if (
    before === undefined &&
    root &&
    Object.hasOwn(root, "default") &&
    isRecord(root.default) &&
    validateEffectiveConfiguration(root, root.default).valid
  )
    return structuredClone(root.default);
  return undefined;
}

function insertDefaults(
  input: InternalUpgradePlannerInput,
  physical: readonly PhysicalLayer[],
  affected: readonly (readonly ScopeInstance[])[],
  anchor: string,
  defaults: readonly UpgradeDefault[],
  replacement: Record<string, unknown>,
): boolean {
  for (const item of defaults) {
    if (
      affected.every((context) =>
        hasOwnPath(
          effectiveAnchor(input, physical, context, anchor),
          item.path,
        ),
      )
    )
      continue;
    if (
      !hasOwnPath(replacement, item.path) &&
      !insertDefault(replacement, item)
    )
      return false;
  }
  return true;
}

function insertDefault(
  replacement: Record<string, unknown>,
  item: UpgradeDefault,
): boolean {
  let current = replacement;
  let schema: ConfigurationPropertySchema = item.rootSchema;
  for (const key of item.path.slice(0, -1)) {
    const childSchema = schema.properties?.[key];
    if (!childSchema) return false;
    const child = current[key];
    if (child === undefined) {
      if (
        !Object.hasOwn(childSchema, "default") ||
        !isRecord(childSchema.default)
      )
        return false;
      current[key] = structuredClone(childSchema.default);
    } else if (!isRecord(child)) return false;
    const next = current[key];
    if (!isRecord(next)) return false;
    current = next;
    schema = childSchema;
  }
  return setOwnPath(current, item.path.slice(-1), item.value);
}

function plannedAnchor(
  layer: PhysicalLayer,
  path: string,
  before: unknown,
  after: unknown,
): PlannedAnchor {
  return {
    target: {
      providerId: layer.providerId,
      namespace: layer.namespace,
      storeId: layer.revision.storeId,
      layer: layer.layer,
      path,
    },
    revision: layer.revision,
    before,
    after,
  };
}

function groupByAnchor(
  additions: readonly UpgradeDefault[],
): ReadonlyMap<string, readonly UpgradeDefault[]> {
  const grouped = new Map<string, UpgradeDefault[]>();
  for (const item of additions)
    grouped.set(item.anchor, [...(grouped.get(item.anchor) ?? []), item]);
  return grouped;
}
