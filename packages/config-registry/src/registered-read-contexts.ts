import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import {
  createWeaverError,
  isReservedPathSegment,
} from "@weaver-conf/config-types";
import {
  expandReadEvidence,
  type ReadEvidence,
  readMemberEvidence,
  readMemberIsAmbiguous,
} from "./registered-read-metadata";
import type { RegistryProjectionReader } from "./registry-contracts";
import { ownValue } from "./structural-witness-own-data";

interface AnchorNode {
  readonly children: Map<string, AnchorNode>;
  schema?: ConfigurationPropertySchema;
}
export interface ReadContext {
  readonly path: readonly string[];
  readonly policies: readonly ConfigurationPropertySchema[];
  readonly hardForbidden: boolean;
  readonly evidence: ReadEvidence;
  readonly candidate: unknown;
  readonly anchor: AnchorNode | undefined;
  readonly declared: boolean;
  readonly forbidden: boolean;
  readonly ancestorDenied: boolean;
  readonly uncertain: boolean;
  readonly sources: readonly unknown[];
}

export function captureReadAnchors(
  reader: RegistryProjectionReader,
  environment: string,
): AnchorNode {
  const root: AnchorNode = { children: new Map() };
  const identities = reader.listRegisteredSchemaIdentities();
  for (const identity of identities.anchors) {
    if (identity.environment !== environment) continue;
    const captured = reader.resolveAnchor(identity.path, environment);
    if (!captured || captured.path !== identity.path) continue;
    // Canonical readers return detached anchor schemas. Capture each once; never
    // replace that authority with another registry or repeatedly clone its body.
    const schema = captured.schema;
    let node = root;
    for (const key of parseCanonicalConfigPath(identity.path).segments) {
      let next = node.children.get(key);
      if (!next) {
        next = { children: new Map() };
        node.children.set(key, next);
      }
      node = next;
    }
    node.schema = schema;
  }
  return root;
}

class ReadContexts {
  readonly root: ReadContext;
  private readonly ids = new Map<unknown, number>();
  private readonly contextKeys = new Map<string, Map<unknown, ReadContext>>();
  private referenceDenial: ((context: ReadContext) => boolean) | undefined;

  constructor(
    anchors: AnchorNode,
    state: Readonly<Record<string, unknown>>,
    sources: readonly unknown[],
    private readonly storagePath: readonly string[] = [],
    private readonly addressed = false,
  ) {
    this.root = this.intern(
      anchors.schema ? [anchors.schema] : [],
      state,
      anchors,
      false,
      sources,
      false,
      false,
    );
  }

  private id(value: unknown): number {
    let found = this.ids.get(value);
    if (found === undefined) {
      found = this.ids.size;
      this.ids.set(value, found);
    }
    return found;
  }

  private intern(
    schemas: readonly ConfigurationPropertySchema[],
    candidate: unknown,
    anchor: AnchorNode | undefined,
    inherited: boolean,
    sources: readonly unknown[],
    uncertain: boolean,
    ancestorDenied: boolean,
    unconstrained = false,
    path: readonly string[] = [],
    policies: readonly ConfigurationPropertySchema[] = [],
    hardForbidden = false,
  ): ReadContext {
    const evidence = expandReadEvidence(schemas, candidate, unconstrained);
    const parts = evidence.schemas.map((schema) => this.id(schema));
    const sourceIds = sources.map((value) => this.id(value));
    const key = [
      this.addressed ? JSON.stringify(path) : "",
      hardForbidden,
      unconstrained,
      inherited || evidence.forbidden,
      ancestorDenied,
      uncertain || evidence.ambiguous,
      anchor ? this.id(anchor) : "",
      parts.join(","),
      // Inherited policy conjunctions must not collapse to one forbidden bit.
      [...new Set(policies)].map((schema) => this.id(schema)).join(","),
      sourceIds.join(","),
    ].join(":");
    const values = this.valuesFor(key);
    const existing = values.get(candidate);
    if (existing) return existing;
    const context = Object.freeze({
      path: Object.freeze([...path]),
      policies: Object.freeze([...policies, ...evidence.schemas]),
      hardForbidden,
      evidence,
      candidate,
      anchor,
      declared:
        unconstrained || schemas.length > 0 || (anchor?.children.size ?? 0) > 0,
      forbidden: inherited || evidence.forbidden,
      ancestorDenied,
      uncertain: uncertain || evidence.ambiguous,
      sources: Object.freeze(sources),
    });
    values.set(candidate, context);
    return context;
  }
  private valuesFor(key: string): Map<unknown, ReadContext> {
    let values = this.contextKeys.get(key);
    if (!values) {
      values = new Map();
      this.contextKeys.set(key, values);
    }
    return values;
  }
  readonly child = (parent: ReadContext, key: string): ReadContext => {
    // Classify the intact parent before narrowing its marker and source context.
    const ancestorDenied =
      parent.ancestorDenied ||
      isReadReference(parent.candidate) ||
      (this.referenceDenial?.(parent) ?? false);
    const anchor = parent.anchor?.children.get(key);
    const member = readMemberEvidence(parent.evidence, key, parent.candidate);
    const schemas = [...member.schemas];
    if (anchor?.schema) schemas.push(anchor.schema);
    const candidate =
      parent.candidate !== null && typeof parent.candidate === "object"
        ? ownValue(parent.candidate, key)
        : undefined;
    const sources = parent.sources.map((value) =>
      value !== null && typeof value === "object"
        ? ownValue(value, key)
        : undefined,
    );
    return this.intern(
      schemas,
      candidate,
      anchor,
      parent.forbidden ||
        this.storageDenied([...parent.path, key]) ||
        isReservedPathSegment(key) ||
        (parent === this.root && key === "_weaver") ||
        readMemberIsAmbiguous(parent.evidence, key, parent.candidate),
      sources,
      parent.uncertain,
      ancestorDenied,
      member.unconstrained,
      [...parent.path, key],
      parent.policies,
      parent.hardForbidden ||
        this.storageDenied([...parent.path, key]) ||
        isReservedPathSegment(key) ||
        (parent === this.root && key === "_weaver") ||
        readMemberIsAmbiguous(parent.evidence, key, parent.candidate),
    );
  };
  private storageDenied(path: readonly string[]): boolean {
    if (!path.includes("instances")) return false;
    if (
      !this.storagePath.length ||
      path.slice(this.storagePath.length).includes("instances")
    )
      return true;
    return path
      .slice(0, this.storagePath.length)
      .some((part, index) => part !== this.storagePath[index]);
  }
  bindReferenceDenial(classify: (context: ReadContext) => boolean): void {
    if (this.referenceDenial)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Read parent policy is already bound",
      );
    this.referenceDenial = classify;
  }
  at(segments: readonly string[]): ReadContext {
    let context = this.root;
    for (const key of segments) {
      if (!context.declared) break;
      context = this.child(context, key);
    }
    return context;
  }
}

export function isReadReference(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const marker = ownValue(value, "_weaver");
  return marker === "secret-ref" || marker === "mount";
}

export function createReadContexts(
  anchors: AnchorNode,
  state: Readonly<Record<string, unknown>>,
  sources: readonly unknown[] = [],
  storagePath: readonly string[] = [],
  addressed = false,
) {
  return new ReadContexts(anchors, state, sources, storagePath, addressed);
}
