import {
  canonicalConfigPathFromStorageKey,
  deepGet,
  parseCanonicalConfigPath,
  validateEffectiveConfiguration,
} from "@weaver-conf/config-engine";
import type { ScopeInstance } from "@weaver-conf/config-types";
import { createWeaverError } from "../types/errors";
import type { ConfigDelta } from "../types/index";
import type { WeaverConfigService } from "./config-service-types";
import type { RegisteredSchemaAnchor } from "./schema-registry";
import { parseScopeQuery } from "./scope-utils";

type AnchorEnumerator = (
  environment: string,
) => ReadonlyArray<RegisteredSchemaAnchor>;

interface SchemaReadBinding {
  readonly anchors: AnchorEnumerator;
}

export interface RuntimeProjectionContext {
  readonly layer: string;
  readonly scopePath?: ScopeInstance[] | undefined;
}

interface AnchorGroup {
  readonly root: RegisteredSchemaAnchor;
  readonly members: RegisteredSchemaAnchor[];
}

type RegistrationProjector = (path: string) => void;

const bindings = new WeakMap<
  WeaverConfigService,
  ReadonlyArray<SchemaReadBinding>
>();
const environments = new WeakMap<WeaverConfigService, string>();
const registrationProjectors = new WeakMap<
  WeaverConfigService,
  RegistrationProjector
>();

export function registerSchemaReadHost(
  service: WeaverConfigService,
  environment: string,
  projectRegistration: RegistrationProjector,
): void {
  environments.set(service, environment);
  registrationProjectors.set(service, projectRegistration);
}

export function bindSchemaReadRegistry(
  service: WeaverConfigService,
  anchors: AnchorEnumerator,
): void {
  const current = bindings.get(service) ?? [];
  bindings.set(service, [...current, { anchors }]);
}

export function notifySchemaRegistration(
  service: WeaverConfigService,
  path: string,
): void {
  registrationProjectors.get(service)?.(path);
}

export function assertValidRuntimeRead(
  service: WeaverConfigService,
  entries: Record<string, unknown>,
  requestedKey?: string,
): void {
  const environment = environmentFor(service);
  const requestedPath = requestedKey
    ? runtimePathFromStorageKey(requestedKey)
    : undefined;
  const anchors = runtimeAnchors(service, environment).filter(
    (anchor) =>
      requestedPath === undefined || pathsIntersect(anchor.path, requestedPath),
  );

  for (const anchor of anchors) {
    const validation = validateAnchor(anchor, entries);
    if (validation.valid) continue;
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Effective configuration does not match registered schema",
      {
        kind: "effective-configuration-invalid",
        anchorPath: anchor.path,
        environment,
        errors: validation.errors,
      },
    );
  }
}

export function assertValidRuntimeScopes(
  service: WeaverConfigService,
  scopes: Record<string, Record<string, unknown>>,
  resolve: (scopePath?: ScopeInstance[]) => Record<string, unknown>,
): void {
  for (const scope of Object.keys(scopes).sort()) {
    assertValidRuntimeRead(service, resolve(parseScopeQuery(scope)));
  }
}

export function projectRuntimeMutation(
  service: WeaverConfigService,
  delta: ConfigDelta,
  contexts: ReadonlyArray<RuntimeProjectionContext>,
  resolve: (scopePath?: ScopeInstance[]) => Record<string, unknown>,
): ConfigDelta[] {
  const projections = projectContexts(service, contexts, resolve, delta);
  const deltaPath = runtimePathFromStorageKey(delta.key);
  const replaced = projectionRoots(service).some(
    (root) => deltaPath !== undefined && pathsIntersect(root.path, deltaPath),
  );
  return replaced
    ? projections
    : [...projections, resolvedSourceDelta(delta, resolve)];
}

export function projectRuntimeRegistration(
  service: WeaverConfigService,
  changedPath: string,
  contexts: ReadonlyArray<RuntimeProjectionContext>,
  resolve: (scopePath?: ScopeInstance[]) => Record<string, unknown>,
): ConfigDelta[] {
  const trigger: ConfigDelta = {
    action: "set",
    key: parseCanonicalConfigPath(changedPath).storageKey,
    value: null,
    layer: "weaver-effective",
    environment: environmentFor(service),
    timestamp: new Date().toISOString(),
  };
  return projectContexts(service, contexts, resolve, trigger, changedPath);
}

function projectContexts(
  service: WeaverConfigService,
  contexts: ReadonlyArray<RuntimeProjectionContext>,
  resolve: (scopePath?: ScopeInstance[]) => Record<string, unknown>,
  trigger: ConfigDelta,
  changedPath?: string,
): ConfigDelta[] {
  const groups = projectionGroups(service).filter(
    (group) =>
      changedPath === undefined || pathsIntersect(group.root.path, changedPath),
  );
  const projected: ConfigDelta[] = [];
  for (const context of sortedContexts(contexts)) {
    const entries = resolve(context.scopePath);
    for (const group of groups) {
      projected.push(projectGroup(group, entries, context.layer, trigger));
    }
  }
  return projected;
}

function projectGroup(
  group: AnchorGroup,
  entries: Record<string, unknown>,
  layer: string,
  trigger: ConfigDelta,
): ConfigDelta {
  const key = parseCanonicalConfigPath(group.root.path).storageKey;
  const valid = group.members.every(
    (anchor) => validateAnchor(anchor, entries).valid,
  );
  const value = deepGet(entries, key);
  if (!valid || value === undefined) {
    return { ...trigger, action: "remove", key, value: null, layer };
  }
  return { ...trigger, action: "set", key, value, layer };
}

function resolvedSourceDelta(
  delta: ConfigDelta,
  resolve: (scopePath?: ScopeInstance[]) => Record<string, unknown>,
): ConfigDelta {
  const scopePath = delta.layer.includes(":")
    ? parseScopeQuery(delta.layer)
    : undefined;
  const value = deepGet(resolve(scopePath), delta.key);
  return value === undefined
    ? { ...delta, action: "remove", value: null }
    : { ...delta, action: "set", value };
}

function projectionGroups(service: WeaverConfigService): AnchorGroup[] {
  const groups: AnchorGroup[] = [];
  for (const anchor of runtimeAnchors(service, environmentFor(service))) {
    const group = groups.find((candidate) =>
      isPathAncestor(candidate.root.path, anchor.path),
    );
    if (group) group.members.push(anchor);
    else groups.push({ root: anchor, members: [anchor] });
  }
  return groups;
}

function projectionRoots(
  service: WeaverConfigService,
): RegisteredSchemaAnchor[] {
  return projectionGroups(service).map((group) => group.root);
}

function runtimeAnchors(
  service: WeaverConfigService,
  environment: string,
): RegisteredSchemaAnchor[] {
  const registered = bindings.get(service) ?? [];
  return registered
    .flatMap((binding) => binding.anchors(environment))
    .sort(compareAnchors);
}

function validateAnchor(
  anchor: RegisteredSchemaAnchor,
  entries: Record<string, unknown>,
) {
  const parsed = parseCanonicalConfigPath(anchor.path);
  return validateEffectiveConfiguration(
    anchor.schema,
    deepGet(entries, parsed.storageKey),
    { path: parsed.segments },
  );
}

function sortedContexts(
  contexts: ReadonlyArray<RuntimeProjectionContext>,
): RuntimeProjectionContext[] {
  const byLayer = new Map<string, RuntimeProjectionContext>();
  for (const context of contexts) byLayer.set(context.layer, context);
  return [...byLayer.values()].sort((left, right) =>
    left.layer.localeCompare(right.layer),
  );
}

function pathsIntersect(left: string, right: string): boolean {
  return isPathAncestor(left, right) || isPathAncestor(right, left);
}

function isPathAncestor(ancestor: string, path: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

function compareAnchors(
  left: RegisteredSchemaAnchor,
  right: RegisteredSchemaAnchor,
): number {
  const depth = pathDepth(left.path) - pathDepth(right.path);
  return (
    depth ||
    left.path.localeCompare(right.path) ||
    left.kind.localeCompare(right.kind)
  );
}

function pathDepth(path: string): number {
  return parseCanonicalConfigPath(path).segments.length;
}

function environmentFor(service: WeaverConfigService): string {
  return environments.get(service) ?? "";
}

function runtimePathFromStorageKey(key: string): string | undefined {
  try {
    return canonicalConfigPathFromStorageKey(key).path;
  } catch {
    return undefined;
  }
}
