interface DataDescriptorSnapshot {
  readonly configurable: boolean;
  readonly enumerable: boolean;
  readonly key: PropertyKey;
  readonly value: unknown;
  readonly writable: boolean;
}

interface ObjectSnapshot {
  readonly descriptors: readonly DataDescriptorSnapshot[];
  readonly extensible: boolean;
  readonly prototype: object | null;
  readonly target: object;
}

type TraversalKind = "constraint" | "schema" | "schema-container" | "shallow";

interface TraversalEntry {
  readonly kind: TraversalKind;
  readonly target: object;
}

export type SchemaStabilitySnapshot =
  | { readonly reusable: false }
  | {
      readonly reusable: true;
      readonly objects: readonly ObjectSnapshot[];
    };

const TRAVERSAL_BITS: Readonly<Record<TraversalKind, number>> = {
  constraint: 1,
  schema: 2,
  "schema-container": 4,
  shallow: 8,
};

export function captureSchemaStability(
  schema: object,
): SchemaStabilitySnapshot {
  const objects: ObjectSnapshot[] = [];
  const records = new WeakMap<object, ObjectSnapshot>();
  const traversed = new WeakMap<object, number>();
  const pending: TraversalEntry[] = [{ kind: "schema", target: schema }];
  try {
    while (pending.length > 0) {
      const entry = pending.pop();
      if (entry === undefined || traversalCompleted(entry, traversed)) continue;
      const snapshot = records.get(entry.target) ?? captureObject(entry.target);
      if (snapshot === undefined) return { reusable: false };
      if (!records.has(entry.target)) {
        records.set(entry.target, snapshot);
        objects.push(snapshot);
      }
      queueObservableEdges(entry, snapshot.descriptors, pending);
    }
    return { reusable: true, objects };
  } catch {
    return { reusable: false };
  }
}

export function schemaStabilityMatches(
  snapshot: SchemaStabilitySnapshot,
): boolean {
  if (!snapshot.reusable) return false;
  try {
    return snapshot.objects.every(objectMatches);
  } catch {
    return false;
  }
}

function captureObject(target: object): ObjectSnapshot | undefined {
  const prototype = Object.getPrototypeOf(target);
  if (!hasSupportedContainerPrototype(target, prototype)) return undefined;
  const descriptors: DataDescriptorSnapshot[] = [];
  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return undefined;
    }
    if (typeof descriptor.value === "function") return undefined;
    descriptors.push(snapshotDescriptor(key, descriptor));
  }
  return {
    descriptors,
    extensible: Object.isExtensible(target),
    prototype,
    target,
  };
}

function queueObservableEdges(
  entry: TraversalEntry,
  descriptors: readonly DataDescriptorSnapshot[],
  pending: TraversalEntry[],
): void {
  if (entry.kind === "shallow") return;
  if (entry.kind === "constraint") {
    queueDescriptorObjects(descriptors, "constraint", pending);
    return;
  }
  if (entry.kind === "schema-container") {
    queueDescriptorObjects(descriptors, "schema", pending);
    return;
  }
  queueSchemaEdges(descriptors, pending);
}

function queueSchemaEdges(
  descriptors: readonly DataDescriptorSnapshot[],
  pending: TraversalEntry[],
): void {
  for (const descriptor of descriptors) {
    if (typeof descriptor.key !== "string") continue;
    const kind = schemaEdgeKind(descriptor.key, descriptor.value);
    if (kind !== undefined) queueObject(descriptor.value, kind, pending);
  }
}

function schemaEdgeKind(
  key: string,
  value: unknown,
): TraversalKind | undefined {
  if (key === "properties" || key === "patternProperties") {
    return "schema-container";
  }
  if (key === "items" && Array.isArray(value)) return "schema-container";
  if (key === "anyOf" || key === "oneOf" || key === "allOf") {
    return "schema-container";
  }
  if (key === "additionalProperties" || key === "items" || key === "not") {
    return "schema";
  }
  if (key === "default" || key === "const" || key === "enum") {
    return "constraint";
  }
  if (key === "type" || key === "required") return "shallow";
  return undefined;
}

function queueDescriptorObjects(
  descriptors: readonly DataDescriptorSnapshot[],
  kind: TraversalKind,
  pending: TraversalEntry[],
): void {
  for (const descriptor of descriptors)
    queueObject(descriptor.value, kind, pending);
}

function queueObject(
  value: unknown,
  kind: TraversalKind,
  pending: TraversalEntry[],
): void {
  if (typeof value === "object" && value !== null) {
    pending.push({ kind, target: value });
  }
}

function traversalCompleted(
  entry: TraversalEntry,
  traversed: WeakMap<object, number>,
): boolean {
  const bit = TRAVERSAL_BITS[entry.kind];
  const previous = traversed.get(entry.target) ?? 0;
  if ((previous & bit) !== 0) return true;
  traversed.set(entry.target, previous | bit);
  return false;
}

function objectMatches(snapshot: ObjectSnapshot): boolean {
  const { target } = snapshot;
  if (Object.getPrototypeOf(target) !== snapshot.prototype) return false;
  if (Object.isExtensible(target) !== snapshot.extensible) return false;
  const keys = Reflect.ownKeys(target);
  if (keys.length !== snapshot.descriptors.length) return false;
  for (let index = 0; index < keys.length; index++) {
    const expected = snapshot.descriptors[index];
    if (expected === undefined || keys[index] !== expected.key) return false;
    const actual = Object.getOwnPropertyDescriptor(target, expected.key);
    if (!descriptorMatches(expected, actual)) return false;
  }
  return true;
}

function descriptorMatches(
  expected: DataDescriptorSnapshot,
  actual: PropertyDescriptor | undefined,
): boolean {
  if (actual === undefined || !Object.hasOwn(actual, "value")) return false;
  return (
    actual.configurable === expected.configurable &&
    actual.enumerable === expected.enumerable &&
    actual.writable === expected.writable &&
    Object.is(actual.value, expected.value)
  );
}

function snapshotDescriptor(
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): DataDescriptorSnapshot {
  return {
    configurable: descriptor.configurable === true,
    enumerable: descriptor.enumerable === true,
    key,
    value: descriptor.value,
    writable: descriptor.writable === true,
  };
}

function hasSupportedContainerPrototype(
  target: object,
  prototype: object | null,
): boolean {
  if (Array.isArray(target)) return prototype === Array.prototype;
  return prototype === Object.prototype || prototype === null;
}
