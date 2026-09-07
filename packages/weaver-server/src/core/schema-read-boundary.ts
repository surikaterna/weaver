import {
  canonicalConfigPathFromStorageKey,
  deepGet,
  parseCanonicalConfigPath,
  validateEffectiveConfiguration,
} from "@weaver-conf/config-engine";
import {
  isConfigMount,
  isSecretReference,
  type ScopeInstance,
} from "@weaver-conf/config-types";
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

export interface ResolvedRuntimeProjectionContext {
  readonly layer: string;
  readonly scopePath?: ScopeInstance[] | undefined;
  readonly entries: Record<string, unknown>;
}

interface AnchorGroup {
  readonly root: RegisteredSchemaAnchor;
  readonly members: RegisteredSchemaAnchor[];
}

type RegistrationProjector = (path: string) => Promise<void>;

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
): Promise<void> {
  return registrationProjectors.get(service)?.(path) ?? Promise.resolve();
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
  contexts: ReadonlyArray<ResolvedRuntimeProjectionContext>,
): ConfigDelta[] {
  const deltaPath = runtimePathFromStorageKey(delta.key);
  const replaced = projectionRoots(service).some(
    (root) => deltaPath !== undefined && pathsIntersect(root.path, deltaPath),
  );
  return projectContexts(service, contexts, delta, undefined, replaced);
}

export function projectRuntimeRegistration(
  service: WeaverConfigService,
  changedPath: string,
  contexts: ReadonlyArray<ResolvedRuntimeProjectionContext>,
): ConfigDelta[] {
  const trigger: ConfigDelta = {
    action: "set",
    key: parseCanonicalConfigPath(changedPath).storageKey,
    value: null,
    layer: "weaver-effective",
    environment: environmentFor(service),
    timestamp: new Date().toISOString(),
  };
  return projectContexts(service, contexts, trigger, changedPath, true);
}

function projectContexts(
  service: WeaverConfigService,
  contexts: ReadonlyArray<ResolvedRuntimeProjectionContext>,
  trigger: ConfigDelta,
  changedPath?: string,
  replaceSource = false,
): ConfigDelta[] {
  const groups = projectionGroups(service).filter(
    (group) =>
      changedPath === undefined || pathsIntersect(group.root.path, changedPath),
  );
  const projected: ConfigDelta[] = [];
  for (const context of sortedContexts(contexts)) {
    for (const group of groups) {
      projected.push(
        projectGroup(group, context.entries, context.layer, trigger),
      );
    }
    if (!replaceSource) projected.push(resolvedSourceDelta(trigger, context));
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
  context: ResolvedRuntimeProjectionContext,
): ConfigDelta {
  const value = deepGet(context.entries, delta.key);
  return value === undefined || containsUnresolvedMarker(value)
    ? { ...delta, action: "remove", value: null, layer: context.layer }
    : { ...delta, action: "set", value, layer: context.layer };
}

function containsUnresolvedMarker(value: unknown): boolean {
  if (isConfigMount(value) || isSecretReference(value)) return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsUnresolvedMarker);
  return Object.values(value).some(containsUnresolvedMarker);
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
  contexts: ReadonlyArray<ResolvedRuntimeProjectionContext>,
): ResolvedRuntimeProjectionContext[] {
  const byLayer = new Map<string, ResolvedRuntimeProjectionContext>();
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
