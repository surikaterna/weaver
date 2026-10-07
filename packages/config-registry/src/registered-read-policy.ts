import {
  createMountSourceClassifier,
  type MountSourceClassifier,
  projectConfigurationData,
} from "@weaver-conf/config-engine";
import { createWeaverError } from "@weaver-conf/config-types";
import {
  type createReadContexts,
  isReadReference,
  type ReadContext,
} from "./registered-read-contexts";
import type { RegisteredReadAccess } from "./registered-read-contracts";
import { ownValue } from "./structural-witness-own-data";

type Contexts = ReturnType<typeof createReadContexts>;

/** Metadata is generation-captured; principal decisions remain query-local. */
function contextAccessible(
  context: ReadContext,
  access: RegisteredReadAccess | undefined,
  sources: readonly ReadContext[],
  validation = false,
): boolean {
  const contexts = [context, ...sources];
  // Raw layers may be partial. Their conservative metadata still intersects
  // access, but required-field failures there do not invalidate resolved data.
  if (
    contexts.some((item) => item.hardForbidden) ||
    (!validation && context.uncertain && context.candidate !== undefined)
  )
    return false;
  const schemas = contexts.flatMap((item) => item.policies);
  if (schemas.some((schema) => schema["x-weaver"]?.visibility === "internal"))
    return false;
  if (!access) return !contexts.some((item) => item.forbidden);
  return (
    access(
      Object.freeze({
        path: context.path,
        schemas: Object.freeze(schemas),
        sensitive: schemas.some(
          (schema) => schema["x-weaver"]?.sensitive === true,
        ),
      }),
    ) === true
  );
}

function marker(value: unknown): unknown {
  return value !== null && typeof value === "object"
    ? ownValue(value, "_weaver")
    : undefined;
}

// A source aggregate must prove every descendant public. Mount roots are followed
// by the shared classifier; nested unresolved references cannot be published.
function sourceForbidden(context: ReadContext, contexts: Contexts): boolean {
  const pending: ReadContext[] = [context];
  const seen = new Set<ReadContext>();
  while (pending.length) {
    const next = pending.pop();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    if (
      !next.declared ||
      next.forbidden ||
      next.ancestorDenied ||
      next.uncertain ||
      next.candidate === undefined
    )
      return true;
    const kind = marker(next.candidate);
    if (kind === "secret-ref") return true;
    if (kind === "mount") {
      if (next !== context) return true;
      continue;
    }
    if (next.candidate === null || typeof next.candidate !== "object") continue;
    for (const key of Object.keys(next.candidate))
      pending.push(contexts.child(next, key));
  }
  return false;
}

class ReadPolicy {
  private readonly decisions = new WeakMap<ReadContext, boolean>();
  constructor(
    private readonly contexts: Contexts,
    private readonly effectiveClassifier: MountSourceClassifier,
    private readonly aliases: readonly MountSourceClassifier[],
    private readonly policySources: (
      context: ReadContext,
    ) => readonly ReadContext[],
  ) {
    contexts.bindReferenceDenial((context) => this.referenceDenied(context));
  }

  denied(context: ReadContext, access?: RegisteredReadAccess): boolean {
    if (context.ancestorDenied) return true;
    if (context.uncertain && context.candidate !== undefined) return true;
    if (this.referenceDenied(context)) return true;
    const sources = this.policySources(context);
    return !contextAccessible(context, access, sources);
  }
  private referenceDenied(context: ReadContext): boolean {
    const cached = this.decisions.get(context);
    if (cached !== undefined) return cached;
    const denied =
      isReadReference(context.candidate) ||
      aliasForbidden(context.sources, this.aliases, this.effectiveClassifier);
    this.decisions.set(context, denied);
    return denied;
  }
  projected(context: ReadContext, access?: RegisteredReadAccess): unknown {
    const denied = new Map<ReadContext, boolean>();
    const excluded = (current: ReadContext): boolean => {
      if (!denied.has(current))
        denied.set(current, !current.declared || this.denied(current, access));
      return denied.get(current) === true;
    };
    return projectConfigurationData(context.candidate, context, {
      decide: (_value, current) =>
        excluded(current) || !this.arrayReadable(current, excluded)
          ? "omit"
          : "descend",
      child: this.contexts.child,
    });
  }
  private arrayReadable(
    context: ReadContext,
    excluded: (context: ReadContext) => boolean,
  ): boolean {
    if (!Array.isArray(context.candidate)) return true;
    if (Object.keys(context.candidate).length !== context.candidate.length)
      return false;
    const pending = [context];
    const seen = new Set<ReadContext>();
    while (pending.length) {
      const current = pending.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      if (excluded(current)) return false;
      if (current.candidate === null || typeof current.candidate !== "object")
        continue;
      for (const key of Object.keys(current.candidate))
        pending.push(this.contexts.child(current, key));
    }
    return true;
  }
  requireDeclared(context: ReadContext): void {
    if (!context.declared)
      throw createWeaverError(
        "SCHEMA_NOT_REGISTERED",
        "Configuration path is not registered",
      );
  }
  authorizeValidation(
    context: ReadContext,
    access?: RegisteredReadAccess,
  ): void {
    this.requireDeclared(context);
    // Invalid alternatives still contribute all applicable metadata. Validation
    // returns sanitized diagnostics, not permission to expose their raw values.
    if (this.validationDenied(context, access))
      throw createWeaverError("FORBIDDEN", "Configuration validation denied");
  }
  validationDenied(
    context: ReadContext,
    access?: RegisteredReadAccess,
  ): boolean {
    return (
      context.ancestorDenied ||
      this.referenceDenied(context) ||
      !contextAccessible(context, access, this.policySources(context), true)
    );
  }
  get(context: ReadContext, access?: RegisteredReadAccess): unknown {
    this.requireDeclared(context);
    if (this.denied(context, access))
      throw createWeaverError(
        "FORBIDDEN",
        "Configuration path is not publicly readable",
      );
    const value = this.projected(context, access);
    if (value === undefined && context.candidate !== undefined)
      throw createWeaverError(
        "FORBIDDEN",
        "Configuration value cannot be projected",
      );
    return value;
  }
}

export function createReadPolicy(
  contexts: Contexts,
  effective: Contexts,
  effectiveState: Readonly<Record<string, unknown>>,
  aliases: readonly MountSourceClassifier[] = [],
  policySources: (context: ReadContext) => readonly ReadContext[] = () => [],
) {
  return new ReadPolicy(
    contexts,
    createReadSourceClassifier(effective, effectiveState),
    aliases,
    policySources,
  );
}

export function createReadSourceClassifier(
  contexts: Contexts,
  state: Readonly<Record<string, unknown>>,
) {
  return createMountSourceClassifier(
    state,
    (path) => sourceForbidden(contexts.at(path), contexts),
    true,
  );
}

function aliasForbidden(
  sources: readonly unknown[],
  aliases: readonly MountSourceClassifier[],
  effective: MountSourceClassifier,
): boolean {
  for (let index = 0; index < sources.length; index++) {
    const value = sources[index];
    if (
      marker(value) !== "mount" ||
      value === null ||
      typeof value !== "object"
    )
      continue;
    const source = ownValue(value, "source");
    if (typeof source !== "string") return true;
    const mount = { _weaver: "mount" as const, source };
    if (effective.isTainted(mount) || aliases[index]?.isTainted(mount))
      return true;
  }
  return false;
}

export function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) return value;
  return Object.freeze({});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
