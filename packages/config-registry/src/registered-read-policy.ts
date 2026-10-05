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
import { ownValue } from "./structural-witness-own-data";

type Contexts = ReturnType<typeof createReadContexts>;

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
  ) {
    contexts.bindReferenceDenial((context) => this.referenceDenied(context));
  }

  denied(context: ReadContext): boolean {
    if (context.forbidden || context.ancestorDenied) return true;
    if (context.uncertain && context.candidate !== undefined) return true;
    return this.referenceDenied(context);
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
  projected(context: ReadContext): unknown {
    return projectConfigurationData(context.candidate, context, {
      decide: (_value, current) =>
        !current.declared || this.denied(current) ? "omit" : "descend",
      child: this.contexts.child,
    });
  }
  requireDeclared(context: ReadContext): void {
    if (!context.declared)
      throw createWeaverError(
        "SCHEMA_NOT_REGISTERED",
        "Configuration path is not registered",
      );
  }
  get(context: ReadContext): unknown {
    this.requireDeclared(context);
    if (this.denied(context))
      throw createWeaverError(
        "FORBIDDEN",
        "Configuration path is not publicly readable",
      );
    return this.projected(context);
  }
}

export function createReadPolicy(
  contexts: Contexts,
  effective: Contexts,
  effectiveState: Readonly<Record<string, unknown>>,
  aliases: readonly MountSourceClassifier[] = [],
) {
  return new ReadPolicy(
    contexts,
    createReadSourceClassifier(effective, effectiveState),
    aliases,
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
