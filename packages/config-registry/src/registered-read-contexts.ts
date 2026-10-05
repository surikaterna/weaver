import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import {
  createWeaverError,
  isReservedPathSegment,
} from "@weaver-conf/config-types";
import {
  expandReadEvidence,
  type ReadEvidence,
  readMemberIsAmbiguous,
  readMemberSchemas,
} from "./registered-read-metadata";
import type { CanonicalSchemaRegistryReader } from "./registry-contracts";
import { ownValue } from "./structural-witness-own-data";

interface AnchorNode {
  readonly children: Map<string, AnchorNode>;
  schema?: ConfigurationPropertySchema;
}
export interface ReadContext {
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
  reader: CanonicalSchemaRegistryReader,
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
  ): ReadContext {
    const evidence = expandReadEvidence(schemas, candidate);
    const parts = evidence.schemas.map((schema) => this.id(schema));
    const sourceIds = sources.map((value) => this.id(value));
    const key = `${inherited || evidence.forbidden}:${ancestorDenied}:${uncertain || evidence.ambiguous}:${anchor ? this.id(anchor) : ""}:${parts.join(",")}:${sourceIds.join(",")}`;
    let values = this.contextKeys.get(key);
    if (!values) {
      values = new Map();
      this.contextKeys.set(key, values);
    }
    const existing = values.get(candidate);
    if (existing) return existing;
    const context = Object.freeze({
      evidence,
      candidate,
      anchor,
      declared: schemas.length > 0 || (anchor?.children.size ?? 0) > 0,
      forbidden: inherited || evidence.forbidden,
      ancestorDenied,
      uncertain: uncertain || evidence.ambiguous,
      sources: Object.freeze(sources),
    });
    values.set(candidate, context);
    return context;
  }
  readonly child = (parent: ReadContext, key: string): ReadContext => {
    // Classify the intact parent before narrowing its marker and source context.
    const ancestorDenied =
      parent.ancestorDenied ||
      isReadReference(parent.candidate) ||
      (this.referenceDenial?.(parent) ?? false);
    const anchor = parent.anchor?.children.get(key);
    const schemas = readMemberSchemas(parent.evidence, key, parent.candidate);
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
        isReservedPathSegment(key) ||
        (parent === this.root && key === "_weaver") ||
        readMemberIsAmbiguous(parent.evidence, key, parent.candidate),
      sources,
      parent.uncertain,
      ancestorDenied,
    );
  };
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
    for (const key of segments) context = this.child(context, key);
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
) {
  return new ReadContexts(anchors, state, sources);
}
