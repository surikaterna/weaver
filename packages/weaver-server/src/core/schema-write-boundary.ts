import {
  canonicalConfigPathFromStorageKey,
  deepGet,
  deepRemove,
  deepSet,
  parseCanonicalConfigPath,
  validateEffectiveConfiguration,
  validatePartialConfiguration,
} from "@weaver-conf/config-engine";
import type { WriteResult } from "@weaver-conf/config-types";
import type { WeaverConfigService } from "./config-service-types";
import { protectedConfigMutationError } from "./protected-config-paths";
import type { RegisteredSchemaAnchor, SchemaRegistry } from "./schema-registry";

interface SchemaBoundaryBinding {
  readonly registry: SchemaRegistry;
  readonly affectedAnchors: (
    path: string,
    environment: string,
  ) => ReadonlyArray<RegisteredSchemaAnchor>;
}

interface ValidationState {
  readonly layerEntries: Record<string, unknown>;
  readonly effectiveEntries?: Record<string, unknown>;
}

export type NormalizedBatchEntries =
  | { readonly success: true; readonly entries: Record<string, unknown> }
  | { readonly success: false; readonly result: WriteResult };

interface BatchPath {
  readonly source: string;
  readonly key: string;
  readonly path: string;
  readonly segments: readonly string[];
  readonly value: unknown;
}

interface BatchPathTrieNode {
  readonly children: Map<string, BatchPathTrieNode>;
  terminal?: BatchPath;
  subtreeTerminalCount: number;
}

interface BatchOverlap {
  readonly ancestor: BatchPath;
  readonly descendant: BatchPath;
}

const bindings = new WeakMap<
  WeaverConfigService,
  ReadonlyArray<SchemaBoundaryBinding>
>();
const defaultEnvironments = new WeakMap<WeaverConfigService, string>();

export function registerSchemaBoundaryHost(
  service: WeaverConfigService,
  defaultEnvironment: string,
): void {
  defaultEnvironments.set(service, defaultEnvironment);
}

export function bindSchemaRegistry(
  service: WeaverConfigService,
  registry: SchemaRegistry,
  affectedAnchors: SchemaBoundaryBinding["affectedAnchors"],
): void {
  const current = bindings.get(service) ?? [];
  if (current.some((binding) => binding.registry === registry)) return;
  bindings.set(service, [...current, { registry, affectedAnchors }]);
}

export function validatePublicWrite(key: string): WriteResult | null {
  return protectedConfigMutationError(key);
}

export function normalizeBatchEntries(
  entries: Record<string, unknown>,
): NormalizedBatchEntries {
  const paths: BatchPath[] = [];
  const sourceByKey = new Map<string, string>();
  for (const [source, value] of Object.entries(entries)) {
    const parsed = parseBatchPath(source, value);
    if (parsed === null)
      return failedBatch("Invalid configuration path", { key: source });
    const previous = sourceByKey.get(parsed.key);
    if (previous !== undefined) {
      return failedBatch("Batch contains duplicate configuration paths", {
        canonicalKey: parsed.key,
        paths: [previous, source],
      });
    }
    sourceByKey.set(parsed.key, source);
    paths.push(parsed);
  }
  const overlap = findBatchOverlap(paths);
  if (overlap !== null) {
    return failedBatch("Batch contains overlapping configuration paths", {
      ancestorKey: overlap.ancestor.key,
      descendantKey: overlap.descendant.key,
      paths: [overlap.ancestor.source, overlap.descendant.source],
    });
  }
  const normalized: Record<string, unknown> = {};
  for (const batchPath of paths) normalized[batchPath.key] = batchPath.value;
  return { success: true, entries: normalized };
}

export function validateBoundSet(
  service: WeaverConfigService,
  key: string,
  value: unknown,
  state: ValidationState,
): WriteResult | null {
  const candidate = structuredClone(state.layerEntries);
  deepSet(candidate, key, value);
  return validateAffected(service, key, candidate, false);
}

export function validateBoundSetMany(
  service: WeaverConfigService,
  entries: Record<string, unknown>,
  layerEntries: Record<string, unknown>,
): WriteResult | null {
  const candidate = structuredClone(layerEntries);
  for (const [key, value] of Object.entries(entries))
    deepSet(candidate, key, value);
  for (const key of Object.keys(entries)) {
    const failure = validateAffected(service, key, candidate, false);
    if (failure) return failure;
  }
  return null;
}

export function validateBoundRemove(
  service: WeaverConfigService,
  key: string,
  state: ValidationState,
): WriteResult | null {
  const candidateLayer = structuredClone(state.layerEntries);
  deepRemove(candidateLayer, key);
  const effective = state.effectiveEntries ?? candidateLayer;
  return validateAffected(service, key, effective, true);
}

function validateAffected(
  service: WeaverConfigService,
  key: string,
  entries: Record<string, unknown>,
  effective: boolean,
): WriteResult | null {
  const serviceBindings = bindings.get(service);
  if (!serviceBindings) return null;
  const environment = defaultEnvironments.get(service) ?? "";
  const path = storagePath(key);
  if (path === null)
    return validationFailure("Invalid configuration path", { key });

  const anchors = serviceBindings.flatMap((binding) =>
    binding.affectedAnchors(path, environment),
  );
  for (const anchor of anchors) {
    const anchorKey = parseCanonicalConfigPath(anchor.path).storageKey;
    const value = deepGet(entries, anchorKey);
    if (!effective && value === undefined) continue;
    const validation = effective
      ? validateEffectiveConfiguration(anchor.schema, value, {
          path: parseCanonicalConfigPath(anchor.path).segments,
        })
      : validatePartialConfiguration(anchor.schema, value, {
          path: parseCanonicalConfigPath(anchor.path).segments,
        });
    if (!validation.valid) {
      return validationFailure(
        "Configuration does not match registered schema",
        {
          path,
          anchorPath: anchor.path,
          environment,
          errors: validation.errors,
        },
      );
    }
  }
  return null;
}

function storagePath(key: string): string | null {
  try {
    return canonicalConfigPathFromStorageKey(key).path;
  } catch {
    return null;
  }
}

function parseBatchPath(source: string, value: unknown): BatchPath | null {
  try {
    const parsed = canonicalConfigPathFromStorageKey(source);
    return {
      source,
      value,
      key: parsed.storageKey,
      path: parsed.path,
      segments: parsed.segments,
    };
  } catch {
    return null;
  }
}

function findBatchOverlap(paths: readonly BatchPath[]): BatchOverlap | null {
  const root = createBatchPathTrieNode();
  for (const path of paths) insertBatchPath(root, path);
  const ancestor = selectOverlapAncestor(root);
  if (ancestor === null) return null;
  const descendant = selectStrictDescendant(ancestor.node);
  return descendant === null ? null : { ancestor: ancestor.path, descendant };
}

function insertBatchPath(root: BatchPathTrieNode, path: BatchPath): void {
  let node = root;
  node.subtreeTerminalCount++;
  for (const segment of path.segments) {
    let child = node.children.get(segment);
    if (child === undefined) {
      child = createBatchPathTrieNode();
      node.children.set(segment, child);
    }
    node = child;
    node.subtreeTerminalCount++;
  }
  node.terminal = path;
}

function selectOverlapAncestor(
  root: BatchPathTrieNode,
): { readonly node: BatchPathTrieNode; readonly path: BatchPath } | null {
  const pending = [root];
  let selected: {
    readonly node: BatchPathTrieNode;
    readonly path: BatchPath;
  } | null = null;
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    const terminal = node.terminal;
    if (
      terminal !== undefined &&
      node.subtreeTerminalCount > 1 &&
      (selected === null || terminal.path < selected.path.path)
    ) {
      selected = { node, path: terminal };
    }
    for (const child of node.children.values()) pending.push(child);
  }
  return selected;
}

function selectStrictDescendant(root: BatchPathTrieNode): BatchPath | null {
  const pending = [...root.children.values()];
  let selected: BatchPath | null = null;
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    const terminal = node.terminal;
    if (
      terminal !== undefined &&
      (selected === null || terminal.path < selected.path)
    ) {
      selected = terminal;
    }
    for (const child of node.children.values()) pending.push(child);
  }
  return selected;
}

function createBatchPathTrieNode(): BatchPathTrieNode {
  return { children: new Map(), subtreeTerminalCount: 0 };
}

function failedBatch(
  message: string,
  details: Record<string, unknown>,
): NormalizedBatchEntries {
  return { success: false, result: validationFailure(message, details) };
}

function validationFailure(
  message: string,
  details: Record<string, unknown>,
): WriteResult {
  return {
    success: false,
    error: { code: "VALIDATION_ERROR", message, details },
  };
}
