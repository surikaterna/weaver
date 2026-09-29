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
import type { RegisteredSchemaAnchor, SchemaRegistry } from "./schema-registry";
import { schemaWriteSupport } from "./schema-write-support";

export interface Mutation {
  readonly key: string;
  readonly value?: unknown;
  readonly operation: "set" | "remove";
  readonly dedicated?: boolean;
  readonly admissionKey?: string;
  readonly admissionValue?: unknown;
}

export interface AdmissionContext {
  readonly registry: SchemaRegistry | undefined;
  readonly environment: string;
  readonly mutations: readonly Mutation[];
  readonly layerBefore: Record<string, unknown>;
  readonly effectiveAfter: (
    layerAfter: Record<string, unknown>,
  ) => Record<string, unknown>;
}

type Prepared =
  | { readonly success: true; readonly layerAfter: Record<string, unknown> }
  | { readonly success: false; readonly result: WriteResult };

function denied(code: string, message: string): Prepared {
  return {
    success: false,
    result: { success: false, error: { code, message } },
  };
}

function overlaps(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function affected(
  registry: SchemaRegistry,
  path: string,
  environment: string,
): RegisteredSchemaAnchor[] {
  return registry
    .listRegisteredSchemaIdentities()
    .anchors.filter(
      (identity) =>
        identity.environment === environment && overlaps(identity.path, path),
    )
    .flatMap((identity) => {
      const schema = registry.getRegisteredSchema(identity.path, environment);
      return schema ? [schema] : [];
    });
}

function isOwner(anchor: RegisteredSchemaAnchor, path: string): boolean {
  return path === anchor.path || path.startsWith(`${anchor.path}/`);
}

function relative(
  anchor: RegisteredSchemaAnchor,
  path: string,
): readonly string[] {
  const root = parseCanonicalConfigPath(anchor.path).segments.length;
  return parseCanonicalConfigPath(path).segments.slice(root);
}

function errorForSupport(
  anchor: RegisteredSchemaAnchor,
  path: string,
  mutation: Mutation,
  after: Record<string, unknown>,
  before: Record<string, unknown>,
): Prepared | null {
  const key = parseCanonicalConfigPath(anchor.path).storageKey;
  const witness = schemaWriteSupport(
    anchor.schema,
    relative(anchor, path),
    mutation.operation === "set"
      ? (mutation.admissionValue ?? mutation.value)
      : undefined,
    deepGet(after, key),
    deepGet(before, key),
  );
  if (witness.arrayIndex && !mutation.dedicated) {
    return denied(
      "UNSUPPORTED_OPERATION",
      `Generic array-index mutation at "${path}" is unsupported`,
    );
  }
  if (witness.ambiguous)
    return denied("VALIDATION_ERROR", `Ambiguous container at "${path}"`);
  if (!witness.declared) {
    const previous = deepGet(before, key);
    const supportBefore = schemaWriteSupport(
      anchor.schema,
      relative(anchor, path),
      mutation.operation === "set"
        ? (mutation.admissionValue ?? mutation.value)
        : undefined,
      previous,
      previous,
    );
    if (supportBefore.declared)
      return denied(
        "VALIDATION_ERROR",
        `Configuration does not match registered schema at "${anchor.path}"`,
      );
    return denied(
      "SCHEMA_NOT_REGISTERED",
      `Path "${path}" has no structural declaration`,
    );
  }
  return null;
}

function anchorValidation(
  anchor: RegisteredSchemaAnchor,
  layerAfter: Record<string, unknown>,
  effective: Record<string, unknown>,
): Prepared | null {
  const key = parseCanonicalConfigPath(anchor.path).storageKey;
  const layerValue = deepGet(layerAfter, key);
  const options = { path: parseCanonicalConfigPath(anchor.path).segments };
  const layerValid =
    layerValue === undefined ||
    validatePartialConfiguration(anchor.schema, layerValue, options).valid;
  const effectiveValue = deepGet(effective, key);
  const effectiveValid =
    effectiveValue === undefined ||
    validateEffectiveConfiguration(anchor.schema, effectiveValue, options)
      .valid;
  if (!layerValid || !effectiveValid) {
    return denied(
      "VALIDATION_ERROR",
      `Configuration does not match registered schema at "${anchor.path}"`,
    );
  }
  return null;
}

function canonicalMutations(
  mutations: readonly Mutation[],
):
  | { readonly success: true; readonly paths: string[] }
  | { readonly success: false; readonly result: Prepared } {
  const paths: string[] = [];
  for (const mutation of mutations) {
    try {
      const path = canonicalConfigPathFromStorageKey(
        mutation.admissionKey ?? mutation.key,
      ).path;
      if (path === "/")
        return {
          success: false,
          result: denied("VALIDATION_ERROR", "Root writes are not supported"),
        };
      if (paths.some((other) => overlaps(other, path))) {
        return {
          success: false,
          result: denied(
            "VALIDATION_ERROR",
            `Overlapping or aliased batch key "${mutation.key}"`,
          ),
        };
      }
      paths.push(path);
    } catch {
      return {
        success: false,
        result: denied(
          "VALIDATION_ERROR",
          `Invalid configuration key "${mutation.key}"`,
        ),
      };
    }
  }
  return { success: true, paths };
}

function layerCandidate(
  before: Record<string, unknown>,
  mutations: readonly Mutation[],
): Prepared {
  try {
    const layerAfter: Record<string, unknown> = structuredClone(before);
    for (const mutation of mutations) {
      if (mutation.operation === "set")
        deepSet(layerAfter, mutation.key, mutation.value);
      else deepRemove(layerAfter, mutation.key);
    }
    return { success: true, layerAfter };
  } catch {
    return denied(
      "VALIDATION_ERROR",
      "Configuration candidate cannot be cloned",
    );
  }
}

function rejectExistingArrayIndices(
  input: AdmissionContext,
  paths: readonly string[],
  effectiveBefore: Record<string, unknown>,
): Prepared | null {
  const registry = input.registry;
  if (!registry) return null;
  for (const [index, path] of paths.entries()) {
    const mutation = input.mutations[index];
    if (!mutation || mutation.dedicated) continue;
    for (const anchor of affected(registry, path, input.environment)) {
      if (!isOwner(anchor, path)) continue;
      const key = parseCanonicalConfigPath(anchor.path).storageKey;
      const old = deepGet(effectiveBefore, key);
      const support = schemaWriteSupport(
        anchor.schema,
        relative(anchor, path),
        mutation.value,
        old,
        old,
      );
      if (support.arrayIndex) {
        return denied(
          "UNSUPPORTED_OPERATION",
          `Generic array-index mutation at "${path}" is unsupported`,
        );
      }
    }
  }
  return null;
}

function inspectTargets(
  input: AdmissionContext,
  paths: readonly string[],
  effective: Record<string, unknown>,
  effectiveBefore: Record<string, unknown>,
  affectedAnchors: Set<RegisteredSchemaAnchor>,
  owned: Set<string>,
): Prepared | null {
  const registry = input.registry;
  if (!registry)
    return denied("INTERNAL_ERROR", "Schema registry is unavailable");
  for (const [index, path] of paths.entries()) {
    const mutation = input.mutations[index];
    if (!mutation) continue;
    const anchors = affected(registry, path, input.environment);
    const owners = anchors.filter((anchor) => isOwner(anchor, path));
    if (owners.length === 0)
      return denied(
        "SCHEMA_NOT_REGISTERED",
        `Path "${path}" is not registered`,
      );
    for (const anchor of anchors) affectedAnchors.add(anchor);
    for (const anchor of owners) {
      owned.add(anchor.path);
      const error = errorForSupport(
        anchor,
        path,
        mutation,
        effective,
        effectiveBefore,
      );
      if (error) return error;
    }
  }
  return null;
}

export function prepareConfigMutation(input: AdmissionContext): Prepared {
  if (!input.registry)
    return denied(
      "INTERNAL_ERROR",
      "Schema registry is not bound to the config service",
    );
  const normalized = canonicalMutations(input.mutations);
  if (!normalized.success) return normalized.result;
  if (normalized.paths.length === 0)
    return { success: true, layerAfter: input.layerBefore };
  const effectiveBefore = input.effectiveAfter(input.layerBefore);
  const arrayFailure = rejectExistingArrayIndices(
    input,
    normalized.paths,
    effectiveBefore,
  );
  if (arrayFailure) return arrayFailure;
  const candidate = layerCandidate(input.layerBefore, input.mutations);
  if (!candidate.success) return candidate;
  const effective = input.effectiveAfter(candidate.layerAfter);
  const affectedAnchors = new Set<RegisteredSchemaAnchor>();
  const owned = new Set<string>();
  const unsupported = inspectTargets(
    input,
    normalized.paths,
    effective,
    effectiveBefore,
    affectedAnchors,
    owned,
  );
  if (unsupported) return unsupported;
  for (const anchor of affectedAnchors) {
    const anchorKey = parseCanonicalConfigPath(anchor.path).storageKey;
    if (!owned.has(anchor.path) && deepGet(effective, anchorKey) === undefined)
      continue;
    const deniedResult = anchorValidation(
      anchor,
      candidate.layerAfter,
      effective,
    );
    if (deniedResult) return deniedResult;
  }
  return candidate;
}
