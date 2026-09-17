import type {
  ConfigurationPropertySchema,
  InternalUpgradePlannerInput,
} from "@weaver-conf/config-types";
import { containsRegistrationDefaultMarker } from "@weaver-conf/config-types";
import { validateEffectiveConfiguration } from "./schema-validation";

export interface UpgradeDefault {
  readonly anchor: string;
  readonly path: readonly string[];
  readonly value: unknown;
  readonly schema: ConfigurationPropertySchema;
  readonly rootSchema: ConfigurationPropertySchema;
  readonly sourceRootSchema?: ConfigurationPropertySchema;
}
export interface UpgradeDiffRefusal {
  readonly code:
    | "missing-default"
    | "invalid-default"
    | "unverifiable-secret"
    | "unsupported-governance"
    | "explicit-disposition-required";
  readonly message: string;
  readonly path: string;
}
export interface UpgradeDiff {
  readonly defaults: readonly UpgradeDefault[];
  readonly refusals: readonly UpgradeDiffRefusal[];
}

export function collectUpgradeDefaults(
  input: InternalUpgradePlannerInput,
): UpgradeDiff {
  const defaults: UpgradeDefault[] = [];
  const refusals: UpgradeDiffRefusal[] = [];
  for (const binding of input.schemas) {
    if (!binding.target) continue;
    collectSchema(
      binding.path,
      [],
      binding.source,
      binding.target,
      binding.target,
      binding.source,
      defaults,
      refusals,
    );
  }
  return { defaults, refusals };
}

function collectSchema(
  anchor: string,
  path: readonly string[],
  source: ConfigurationPropertySchema | undefined,
  target: ConfigurationPropertySchema,
  root: ConfigurationPropertySchema,
  sourceRoot: ConfigurationPropertySchema | undefined,
  defaults: UpgradeDefault[],
  refusals: UpgradeDiffRefusal[],
): void {
  if (refuseOpenGovernance(anchor, path, source, target, refusals)) return;
  const properties = target.properties ?? {};
  collectRemovedProperties(anchor, path, source, properties, refusals);
  for (const key of Object.keys(properties).sort())
    collectTargetProperty(
      anchor,
      path,
      key,
      source,
      target,
      root,
      sourceRoot,
      defaults,
      refusals,
    );
}

function collectTargetProperty(
  anchor: string,
  path: readonly string[],
  key: string,
  source: ConfigurationPropertySchema | undefined,
  target: ConfigurationPropertySchema,
  root: ConfigurationPropertySchema,
  sourceRoot: ConfigurationPropertySchema | undefined,
  defaults: UpgradeDefault[],
  refusals: UpgradeDiffRefusal[],
): void {
  const child = target.properties?.[key];
  if (!child) return;
  const previous = source?.properties?.[key];
  const childPath = [...path, key];
  if (!previous) {
    collectIntroduced(
      anchor,
      childPath,
      child,
      root,
      sourceRoot,
      defaults,
      refusals,
    );
    return;
  }
  collectExistingProperty(
    anchor,
    childPath,
    source,
    target,
    key,
    previous,
    child,
    root,
    sourceRoot,
    defaults,
    refusals,
  );
}

function collectExistingProperty(
  anchor: string,
  childPath: readonly string[],
  source: ConfigurationPropertySchema,
  target: ConfigurationPropertySchema,
  key: string,
  previous: ConfigurationPropertySchema,
  child: ConfigurationPropertySchema,
  root: ConfigurationPropertySchema,
  sourceRoot: ConfigurationPropertySchema | undefined,
  defaults: UpgradeDefault[],
  refusals: UpgradeDiffRefusal[],
): void {
  collectNewlyRequired(
    anchor,
    childPath,
    source,
    target,
    key,
    child,
    root,
    sourceRoot,
    defaults,
    refusals,
  );
  collectSchema(
    anchor,
    childPath,
    previous,
    child,
    root,
    sourceRoot,
    defaults,
    refusals,
  );
}

function refuseOpenGovernance(
  anchor: string,
  path: readonly string[],
  source: ConfigurationPropertySchema | undefined,
  target: ConfigurationPropertySchema,
  refusals: UpgradeDiffRefusal[],
): boolean {
  if (!governanceChanged(source, target) || !hasOpenGovernance(target))
    return false;
  refusals.push(
    refusal(
      "unsupported-governance",
      anchor,
      path,
      "Open or pattern governance is not finitely enumerable",
    ),
  );
  return true;
}

function collectRemovedProperties(
  anchor: string,
  path: readonly string[],
  source: ConfigurationPropertySchema | undefined,
  target: Readonly<Record<string, ConfigurationPropertySchema>>,
  refusals: UpgradeDiffRefusal[],
): void {
  for (const key of Object.keys(source?.properties ?? {}).sort())
    if (!Object.hasOwn(target, key))
      refusals.push(
        refusal(
          "explicit-disposition-required",
          anchor,
          [...path, key],
          "Removing a named governed property requires an explicit disposition",
        ),
      );
}

function collectNewlyRequired(
  anchor: string,
  path: readonly string[],
  source: ConfigurationPropertySchema,
  target: ConfigurationPropertySchema,
  key: string,
  child: ConfigurationPropertySchema,
  root: ConfigurationPropertySchema,
  sourceRoot: ConfigurationPropertySchema | undefined,
  defaults: UpgradeDefault[],
  refusals: UpgradeDiffRefusal[],
): void {
  if (
    !new Set(target.required ?? []).has(key) ||
    new Set(source.required ?? []).has(key)
  )
    return;
  collectOwnDefault(anchor, path, child, root, sourceRoot, defaults, refusals);
}

function collectIntroduced(
  anchor: string,
  path: readonly string[],
  schema: ConfigurationPropertySchema,
  root: ConfigurationPropertySchema,
  sourceRoot: ConfigurationPropertySchema | undefined,
  defaults: UpgradeDefault[],
  refusals: UpgradeDiffRefusal[],
): void {
  if (hasOpenGovernance(schema)) {
    refusals.push(
      refusal(
        "unsupported-governance",
        anchor,
        path,
        "Introduced open or pattern governance is not enumerable",
      ),
    );
    return;
  }
  collectOwnDefault(anchor, path, schema, root, sourceRoot, defaults, refusals);
  for (const key of Object.keys(schema.properties ?? {}).sort()) {
    const child = schema.properties?.[key];
    if (child)
      collectIntroduced(
        anchor,
        [...path, key],
        child,
        root,
        sourceRoot,
        defaults,
        refusals,
      );
  }
}

function collectOwnDefault(
  anchor: string,
  path: readonly string[],
  schema: ConfigurationPropertySchema,
  root: ConfigurationPropertySchema,
  sourceRoot: ConfigurationPropertySchema | undefined,
  defaults: UpgradeDefault[],
  refusals: UpgradeDiffRefusal[],
): void {
  const invalid = validateOwnDefault(anchor, path, schema);
  if (invalid) refusals.push(invalid);
  else
    defaults.push({
      anchor,
      path,
      value: structuredClone(schema.default),
      schema,
      rootSchema: root,
      ...(sourceRoot ? { sourceRootSchema: sourceRoot } : {}),
    });
}

function validateOwnDefault(
  anchor: string,
  path: readonly string[],
  schema: ConfigurationPropertySchema,
): UpgradeDiffRefusal | undefined {
  if (!Object.hasOwn(schema, "default"))
    return refusal(
      "missing-default",
      anchor,
      path,
      "Newly governed properties require an own typed default",
    );
  if (
    schema["x-weaver"]?.sensitive ||
    containsRegistrationDefaultMarker(schema.default)
  )
    return refusal(
      "unverifiable-secret",
      anchor,
      path,
      "Sensitive or marker defaults cannot be planned",
    );
  if (!validateEffectiveConfiguration(schema, schema.default).valid)
    return refusal(
      "invalid-default",
      anchor,
      path,
      "Newly governed property default is invalid",
    );
}

function hasOpenGovernance(
  schema: ConfigurationPropertySchema | undefined,
): boolean {
  return (
    Object.keys(schema?.patternProperties ?? {}).length > 0 ||
    typeof schema?.additionalProperties === "object"
  );
}

function governanceChanged(
  source: ConfigurationPropertySchema | undefined,
  target: ConfigurationPropertySchema,
): boolean {
  return (
    JSON.stringify(source?.patternProperties ?? null) !==
      JSON.stringify(target.patternProperties ?? null) ||
    JSON.stringify(source?.additionalProperties ?? null) !==
      JSON.stringify(target.additionalProperties ?? null)
  );
}

function refusal(
  code: UpgradeDiffRefusal["code"],
  anchor: string,
  path: readonly string[],
  message: string,
): UpgradeDiffRefusal {
  return {
    code,
    message,
    path: `${anchor}${path.length ? `/${path.join("/")}` : ""}`,
  };
}
