import type {
  ConfigurationPropertySchema,
  ObjectConfigurationPropertySchema,
} from "@weaver-conf/config-types";
import { objectConfigurationPropertySchemaSchema } from "@weaver-conf/config-types";
import { z } from "zod";

export const schemaGraphEncoding = "weaver.configuration-property-schema-graph";

const nodeIdSchema = z.number().int().nonnegative();
const encodedNodeSchema = z.strictObject({
  type: z.unknown(),
  title: z.unknown().optional(),
  default: z.unknown().optional(),
  description: z.unknown().optional(),
  examples: z.unknown().optional(),
  const: z.unknown().optional(),
  enum: z.unknown().optional(),
  format: z.unknown().optional(),
  pattern: z.unknown().optional(),
  minLength: z.unknown().optional(),
  maxLength: z.unknown().optional(),
  multipleOf: z.unknown().optional(),
  minimum: z.unknown().optional(),
  maximum: z.unknown().optional(),
  exclusiveMinimum: z.unknown().optional(),
  exclusiveMaximum: z.unknown().optional(),
  minItems: z.unknown().optional(),
  maxItems: z.unknown().optional(),
  uniqueItems: z.unknown().optional(),
  minProperties: z.unknown().optional(),
  maxProperties: z.unknown().optional(),
  required: z.unknown().optional(),
  properties: z.record(z.string(), nodeIdSchema).optional(),
  patternProperties: z.record(z.string(), nodeIdSchema).optional(),
  additionalProperties: z.union([z.boolean(), nodeIdSchema]).optional(),
  items: z.union([nodeIdSchema, z.array(nodeIdSchema)]).optional(),
  oneOf: z.array(nodeIdSchema).optional(),
  anyOf: z.array(nodeIdSchema).optional(),
  allOf: z.array(nodeIdSchema).optional(),
  not: nodeIdSchema.optional(),
  $ref: z.never().optional(),
  $defs: z.never().optional(),
  "x-weaver": z.unknown().optional(),
});

export const persistedSchemaGraphSchema = z.strictObject({
  encoding: z.literal(schemaGraphEncoding),
  version: z.literal(1),
  root: z.literal(0),
  nodes: z.array(encodedNodeSchema).min(1),
});

export type PersistedSchemaGraph = z.infer<typeof persistedSchemaGraphSchema>;
type EncodedNode = z.infer<typeof encodedNodeSchema>;
type NodeRecord = Record<string, unknown>;
type MutableEncodedNode = EncodedNode & NodeRecord;
type EncodeFrame =
  | {
      readonly kind: "enter";
      readonly schema: ConfigurationPropertySchema;
      readonly attach: (id: number) => void;
    }
  | { readonly kind: "exit"; readonly schema: ConfigurationPropertySchema };
type DecodeFrame =
  | { readonly kind: "enter"; readonly id: number }
  | { readonly kind: "exit"; readonly id: number };

const scalarKeys = [
  "type",
  "title",
  "default",
  "description",
  "examples",
  "const",
  "enum",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "multipleOf",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "required",
] as const;

const compositionKeys = ["oneOf", "anyOf", "allOf"] as const;

export function encodeSchemaGraph(
  root: ObjectConfigurationPropertySchema,
): PersistedSchemaGraph {
  const nodes: EncodedNode[] = [];
  const ids = new WeakMap<object, number>();
  const active = new WeakSet<object>();
  const complete = new WeakSet<object>();
  let rootId = -1;
  const pending: EncodeFrame[] = [
    { kind: "enter", schema: root, attach: (id) => (rootId = id) },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === "exit") {
      active.delete(frame.schema);
      complete.add(frame.schema);
      continue;
    }
    const existing = ids.get(frame.schema);
    if (active.has(frame.schema))
      throw new Error("Schema graph must not contain cycles");
    if (existing !== undefined && complete.has(frame.schema)) {
      frame.attach(existing);
      continue;
    }
    const id = nodes.length;
    ids.set(frame.schema, id);
    active.add(frame.schema);
    frame.attach(id);
    const encoded: MutableEncodedNode = { type: frame.schema.type };
    nodes.push(encoded);
    const children = encodeNode(frame.schema, encoded);
    pending.push({ kind: "exit", schema: frame.schema });
    pushEncodeFrames(pending, children);
  }
  if (rootId !== 0) throw new Error("Schema graph root encoding failed");
  return { encoding: schemaGraphEncoding, version: 1, root: 0, nodes };
}

interface EncodeChild {
  readonly schema: ConfigurationPropertySchema;
  readonly attach: (id: number) => void;
}
function encodeNode(
  schema: ConfigurationPropertySchema,
  output: NodeRecord,
): readonly EncodeChild[] {
  const children: EncodeChild[] = [];
  copyScalars(schema, output);
  encodeMap(schema, output, "properties", children);
  encodeMap(schema, output, "patternProperties", children);
  encodeAdditional(schema, output, children);
  encodeItems(schema, output, children);
  for (const key of compositionKeys) encodeArray(schema, output, key, children);
  encodeSingle(schema, output, "not", children);
  copyOwn(schema, output, "$ref");
  copyOwn(schema, output, "$defs");
  copyOwn(schema, output, "x-weaver");
  return children;
}
function copyScalars(schema: object, output: NodeRecord): void {
  for (const key of scalarKeys) copyOwn(schema, output, key);
}

function copyOwn(source: object, target: NodeRecord, key: string): void {
  if (Object.hasOwn(source, key))
    defineOwn(target, key, Reflect.get(source, key));
}

function encodeMap(
  schema: ConfigurationPropertySchema,
  output: NodeRecord,
  key: "properties" | "patternProperties",
  children: EncodeChild[],
): void {
  const map = schema[key];
  if (map === undefined) return;
  const encoded: Record<string, number> = {};
  defineOwn(output, key, encoded);
  for (const name of Object.keys(map)) {
    const child = map[name];
    if (child !== undefined) {
      children.push({
        schema: child,
        attach: (id) => defineOwn(encoded, name, id),
      });
    }
  }
}

function encodeAdditional(
  schema: ConfigurationPropertySchema,
  output: NodeRecord,
  children: EncodeChild[],
): void {
  const child = schema.additionalProperties;
  if (child === undefined) return;
  if (typeof child === "boolean")
    defineOwn(output, "additionalProperties", child);
  else encodeReference(output, "additionalProperties", child, children);
}

function encodeItems(
  schema: ConfigurationPropertySchema,
  output: NodeRecord,
  children: EncodeChild[],
): void {
  const items = schema.items;
  if (items === undefined) return;
  if (isSchemaArray(items)) {
    encodeArrayValue(output, "items", items, children);
    return;
  }
  encodeReference(output, "items", items, children);
}

function encodeArray(
  schema: ConfigurationPropertySchema,
  output: NodeRecord,
  key: "oneOf" | "anyOf" | "allOf",
  children: EncodeChild[],
): void {
  const value = schema[key];
  if (value !== undefined) encodeArrayValue(output, key, value, children);
}

function encodeArrayValue(
  output: NodeRecord,
  key: string,
  schemas: readonly ConfigurationPropertySchema[],
  children: EncodeChild[],
): void {
  const ids: number[] = [];
  defineOwn(output, key, ids);
  for (let index = 0; index < schemas.length; index++) {
    const child = schemas[index];
    if (child !== undefined)
      children.push({ schema: child, attach: (id) => (ids[index] = id) });
  }
}

function encodeSingle(
  schema: ConfigurationPropertySchema,
  output: NodeRecord,
  key: "not",
  children: EncodeChild[],
): void {
  const child = schema[key];
  if (child !== undefined) encodeReference(output, key, child, children);
}

function encodeReference(
  output: NodeRecord,
  key: string,
  schema: ConfigurationPropertySchema,
  children: EncodeChild[],
): void {
  defineOwn(output, key, -1);
  children.push({ schema, attach: (id) => defineOwn(output, key, id) });
}

export function decodeSchemaGraph(
  input: unknown,
): ObjectConfigurationPropertySchema {
  const encoded = persistedSchemaGraphSchema.parse(input);
  validateEncodedGraph(encoded.nodes);
  const schemas = encoded.nodes.map((node) => decodeNodeScalars(node));
  for (let id = 0; id < encoded.nodes.length; id++) {
    const node = encoded.nodes[id];
    const schema = schemas[id];
    if (node !== undefined && schema !== undefined)
      wireNode(node, schema, schemas);
  }
  return objectConfigurationPropertySchemaSchema.parse(schemas[0]);
}

function validateEncodedGraph(nodes: readonly EncodedNode[]): void {
  const active = new Set<number>();
  const complete = new Set<number>();
  const pending: DecodeFrame[] = [{ kind: "enter", id: 0 }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === "exit") {
      active.delete(frame.id);
      complete.add(frame.id);
      continue;
    }
    if (active.has(frame.id))
      throw new Error("Persisted schema graph contains a cycle");
    if (complete.has(frame.id)) continue;
    const node = nodes[frame.id];
    if (node === undefined)
      throw new Error(`Invalid schema node reference ${String(frame.id)}`);
    active.add(frame.id);
    pending.push({ kind: "exit", id: frame.id });
    const refs = nodeReferences(node);
    for (let index = refs.length - 1; index >= 0; index--) {
      const id = refs[index];
      if (id === undefined || id >= nodes.length) {
        throw new Error(`Invalid schema node reference ${String(id)}`);
      }
      pending.push({ kind: "enter", id });
    }
  }
  if (complete.size !== nodes.length)
    throw new Error("Persisted schema graph has unreachable nodes");
}

function nodeReferences(node: EncodedNode): readonly number[] {
  const refs: number[] = [];
  if (node.properties) refs.push(...Object.values(node.properties));
  if (node.patternProperties)
    refs.push(...Object.values(node.patternProperties));
  if (typeof node.additionalProperties === "number")
    refs.push(node.additionalProperties);
  if (typeof node.items === "number") refs.push(node.items);
  else if (node.items) refs.push(...node.items);
  for (const key of compositionKeys) if (node[key]) refs.push(...node[key]);
  if (node.not !== undefined) refs.push(node.not);
  return refs;
}

function decodeNodeScalars(node: EncodedNode): NodeRecord {
  const schema: NodeRecord = {};
  copyScalars(node, schema);
  return schema;
}

function wireNode(
  node: EncodedNode,
  schema: NodeRecord,
  nodes: readonly NodeRecord[],
): void {
  wireMap(node, schema, nodes, "properties");
  wireMap(node, schema, nodes, "patternProperties");
  if (typeof node.additionalProperties === "boolean") {
    defineOwn(schema, "additionalProperties", node.additionalProperties);
  } else if (node.additionalProperties !== undefined) {
    defineOwn(schema, "additionalProperties", nodes[node.additionalProperties]);
  }
  if (typeof node.items === "number")
    defineOwn(schema, "items", nodes[node.items]);
  else if (node.items)
    defineOwn(
      schema,
      "items",
      node.items.map((id) => nodes[id]),
    );
  for (const key of compositionKeys) {
    const ids = node[key];
    if (ids)
      defineOwn(
        schema,
        key,
        ids.map((id) => nodes[id]),
      );
  }
  if (node.not !== undefined) defineOwn(schema, "not", nodes[node.not]);
  copyOwn(node, schema, "$ref");
  copyOwn(node, schema, "$defs");
  copyOwn(node, schema, "x-weaver");
}

function wireMap(
  node: EncodedNode,
  schema: NodeRecord,
  nodes: readonly NodeRecord[],
  key: "properties" | "patternProperties",
): void {
  const ids = node[key];
  if (ids === undefined) return;
  const output: NodeRecord = {};
  defineOwn(schema, key, output);
  for (const name of Object.keys(ids))
    defineOwn(output, name, nodes[ids[name] ?? -1]);
}

function pushEncodeFrames(
  pending: EncodeFrame[],
  children: readonly EncodeChild[],
): void {
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (child !== undefined) pending.push({ kind: "enter", ...child });
  }
}

function defineOwn(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
function isSchemaArray(
  value: ConfigurationPropertySchema | readonly ConfigurationPropertySchema[],
): value is readonly ConfigurationPropertySchema[] {
  return Array.isArray(value);
}
