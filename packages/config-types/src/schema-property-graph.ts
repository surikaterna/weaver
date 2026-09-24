import { z } from "zod";
import type {
  ConfigurationPropertySchema,
  ObjectConfigurationPropertySchema,
} from "./property-schema";

type SchemaPath = readonly PropertyKey[];
interface ShallowSchema {
  readonly type: ConfigurationPropertySchema["type"];
  readonly [key: string]: unknown;
}
interface GraphError {
  readonly message: string;
  readonly path: SchemaPath;
}
interface ChildEdge {
  readonly input: unknown;
  readonly path: SchemaPath;
  readonly attach: (schema: ConfigurationPropertySchema) => void;
}
type GraphFrame =
  | { readonly kind: "enter"; readonly edge: ChildEdge }
  | { readonly kind: "exit"; readonly input: object };
type GraphResult =
  | { readonly success: true; readonly data: ConfigurationPropertySchema }
  | { readonly success: false; readonly error: GraphError };
export function createSchemaPropertyGraphSchema(
  shallowSchema: z.ZodType<ShallowSchema>,
  objectRoot: boolean,
): z.ZodType<ConfigurationPropertySchema> {
  return z.unknown().transform((input, context) => {
    const result = parseGraph(input, shallowSchema, objectRoot);
    if (result.success) return result.data;
    context.addIssue({
      code: "custom",
      message: result.error.message,
      path: [...result.error.path],
    });
    return z.NEVER;
  });
}
export function createObjectSchemaPropertyGraphSchema(
  shallowSchema: z.ZodType<ShallowSchema>,
): z.ZodType<ObjectConfigurationPropertySchema> {
  const graphSchema = createSchemaPropertyGraphSchema(shallowSchema, true);
  // The graph parser verifies the exact root type before returning success.
  return graphSchema as z.ZodType<ObjectConfigurationPropertySchema>;
}
function parseGraph(
  input: unknown,
  shallowSchema: z.ZodType<ShallowSchema>,
  objectRoot: boolean,
): GraphResult {
  let root: ConfigurationPropertySchema | undefined;
  const rootEdge: ChildEdge = {
    input,
    path: [],
    attach: (schema) => {
      root = schema;
    },
  };
  const parsed = cloneGraph(rootEdge, shallowSchema);
  if (!parsed.success) {
    if (
      objectRoot &&
      parsed.error.path.length === 1 &&
      parsed.error.path[0] === "type"
    ) {
      return graphFailure(
        ["type"],
        'Registered schema root must declare type exactly "object"',
      );
    }
    return parsed;
  }
  if (root === undefined) return graphFailure([], "Schema graph is empty");
  if (objectRoot && root.type !== "object") {
    return graphFailure(
      ["type"],
      'Registered schema root must declare type exactly "object"',
    );
  }
  return { success: true, data: root };
}
function cloneGraph(
  root: ChildEdge,
  shallowSchema: z.ZodType<ShallowSchema>,
): { readonly success: true } | { readonly success: false; error: GraphError } {
  const clones = new WeakMap<object, ConfigurationPropertySchema>();
  const active = new WeakSet<object>();
  const complete = new WeakSet<object>();
  const pending: GraphFrame[] = [{ kind: "enter", edge: root }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === "exit") {
      active.delete(frame.input);
      complete.add(frame.input);
      continue;
    }
    const result = enterNode(
      frame.edge,
      shallowSchema,
      clones,
      active,
      complete,
    );
    if (!result.success) return result;
    if (result.reused) continue;
    pending.push({ kind: "exit", input: result.input });
    pushEdges(pending, result.edges);
  }
  return { success: true };
}
type EnterResult =
  | { readonly success: false; readonly error: GraphError }
  | { readonly success: true; readonly reused: true }
  | {
      readonly success: true;
      readonly reused: false;
      readonly input: object;
      readonly edges: readonly ChildEdge[];
    };
function enterNode(
  edge: ChildEdge,
  shallowSchema: z.ZodType<ShallowSchema>,
  clones: WeakMap<object, ConfigurationPropertySchema>,
  active: WeakSet<object>,
  complete: WeakSet<object>,
): EnterResult {
  if (!isObjectNode(edge.input)) {
    return graphFailure(edge.path, "Expected schema object");
  }
  if (active.has(edge.input)) {
    return graphFailure(edge.path, "Schema graph must not contain cycles");
  }
  const existing = clones.get(edge.input);
  if (existing !== undefined && complete.has(edge.input)) {
    edge.attach(existing);
    return { success: true, reused: true };
  }
  const snapshot = snapshotRecord(edge.input, edge.path, "schema");
  if (!snapshot.success) return snapshot;
  const parsed = shallowSchema.safeParse(snapshot.data);
  if (!parsed.success) return shallowFailure(edge.path, parsed.error);
  // Structural fields are replaced below after the shallow contract validates scalars.
  const clone = parsed.data as ConfigurationPropertySchema;
  edge.attach(clone);
  clones.set(edge.input, clone);
  active.add(edge.input);
  const edges = collectEdges(edge.input, clone, edge.path);
  if (!edges.success) return edges;
  return { success: true, reused: false, input: edge.input, edges: edges.data };
}
function collectEdges(
  input: object,
  clone: ConfigurationPropertySchema,
  path: SchemaPath,
):
  | { readonly success: true; readonly data: readonly ChildEdge[] }
  | { readonly success: false; readonly error: GraphError } {
  const edges: ChildEdge[] = [];
  for (const key of ["properties", "patternProperties"] as const) {
    const result = collectMapEdges(input, clone, key, path);
    if (!result.success) return result;
    edges.push(...result.data);
  }
  const additional = collectAdditionalProperties(input, clone, path);
  if (!additional.success) return additional;
  edges.push(...additional.data);
  const items = collectItems(input, clone, path);
  if (!items.success) return items;
  edges.push(...items.data);
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const result = collectArrayEdges(input, clone, key, path);
    if (!result.success) return result;
    edges.push(...result.data);
  }
  const not = collectNot(input, clone, path);
  if (!not.success) return not;
  edges.push(...not.data);
  return { success: true, data: edges };
}
function collectMapEdges(
  input: object,
  clone: ConfigurationPropertySchema,
  key: "properties" | "patternProperties",
  path: SchemaPath,
): EdgeCollection {
  const value = ownDataValue(input, key);
  if (!value.present || value.data === undefined) return emptyEdges();
  if (!isObjectNode(value.data)) {
    return graphFailure([...path, key], "Expected schema record");
  }
  const snapshot = snapshotRecord(value.data, [...path, key], key);
  if (!snapshot.success) return snapshot;
  const output: Record<string, ConfigurationPropertySchema> = {};
  defineOwn(clone, key, output);
  const edges: ChildEdge[] = [];
  for (const name of Object.keys(snapshot.data)) {
    edges.push({
      input: snapshot.data[name],
      path: [...path, key, name],
      attach: (schema) => defineOwn(output, name, schema),
    });
  }
  return { success: true, data: edges };
}
function collectAdditionalProperties(
  input: object,
  clone: ConfigurationPropertySchema,
  path: SchemaPath,
): EdgeCollection {
  const value = ownDataValue(input, "additionalProperties");
  if (
    !value.present ||
    value.data === undefined ||
    typeof value.data === "boolean"
  ) {
    return emptyEdges();
  }
  return {
    success: true,
    data: [
      {
        input: value.data,
        path: [...path, "additionalProperties"],
        attach: (schema) => defineOwn(clone, "additionalProperties", schema),
      },
    ],
  };
}
function collectItems(
  input: object,
  clone: ConfigurationPropertySchema,
  path: SchemaPath,
): EdgeCollection {
  const value = ownDataValue(input, "items");
  if (!value.present || value.data === undefined) return emptyEdges();
  if (!Array.isArray(value.data)) {
    return {
      success: true,
      data: [
        {
          input: value.data,
          path: [...path, "items"],
          attach: (schema) => defineOwn(clone, "items", schema),
        },
      ],
    };
  }
  return collectStructuralArray(value.data, clone, "items", path);
}
function collectArrayEdges(
  input: object,
  clone: ConfigurationPropertySchema,
  key: "oneOf" | "anyOf" | "allOf",
  path: SchemaPath,
): EdgeCollection {
  const value = ownDataValue(input, key);
  if (!value.present || value.data === undefined) return emptyEdges();
  if (!Array.isArray(value.data)) {
    return graphFailure([...path, key], "Expected array");
  }
  return collectStructuralArray(value.data, clone, key, path);
}
function collectStructuralArray(
  input: readonly unknown[],
  clone: ConfigurationPropertySchema,
  key: "items" | "oneOf" | "anyOf" | "allOf",
  path: SchemaPath,
): EdgeCollection {
  const values = snapshotDenseArray(input, [...path, key]);
  if (!values.success) return values;
  const output: ConfigurationPropertySchema[] = [];
  defineOwn(clone, key, output);
  const edges = values.data.map((child, index) => ({
    input: child,
    path: [...path, key, index],
    attach: (schema: ConfigurationPropertySchema) => {
      output[index] = schema;
      if (index === values.data.length - 1) Object.freeze(output);
    },
  }));
  if (values.data.length === 0) Object.freeze(output);
  return { success: true, data: edges };
}
function collectNot(
  input: object,
  clone: ConfigurationPropertySchema,
  path: SchemaPath,
): EdgeCollection {
  const value = ownDataValue(input, "not");
  if (!value.present || value.data === undefined) return emptyEdges();
  return {
    success: true,
    data: [
      {
        input: value.data,
        path: [...path, "not"],
        attach: (schema) => defineOwn(clone, "not", schema),
      },
    ],
  };
}
type EdgeCollection =
  | { readonly success: true; readonly data: readonly ChildEdge[] }
  | { readonly success: false; readonly error: GraphError };
function snapshotRecord(
  input: object,
  path: SchemaPath,
  label: string,
):
  | { readonly success: true; readonly data: Record<string, unknown> }
  | { readonly success: false; readonly error: GraphError } {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return graphFailure(
        [...path, key],
        `${label} accessors are not supported`,
      );
    }
    defineOwn(output, key, descriptor.value);
  }
  return { success: true, data: output };
}
function snapshotDenseArray(
  input: readonly unknown[],
  path: SchemaPath,
):
  | { readonly success: true; readonly data: readonly unknown[] }
  | { readonly success: false; readonly error: GraphError } {
  const output: unknown[] = [];
  for (const key of Object.keys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor !== undefined && !("value" in descriptor)) {
      return graphFailure(
        [...path, key],
        "Structural array accessors are not supported",
      );
    }
  }
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined) {
      return graphFailure([...path, index], "Structural arrays must be dense");
    }
    if (!("value" in descriptor)) {
      return graphFailure(
        [...path, index],
        "Structural array accessors are not supported",
      );
    }
    output.push(descriptor.value);
  }
  return { success: true, data: output };
}
function ownDataValue(
  input: object,
  key: string,
): { readonly present: boolean; readonly data?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    return { present: false };
  }
  return { present: true, data: descriptor.value };
}
function shallowFailure(path: SchemaPath, error: z.ZodError): EnterResult {
  const issue = error.issues[0];
  if (issue === undefined) return graphFailure(path, "Invalid schema node");
  return graphFailure([...path, ...issue.path], issue.message);
}
function graphFailure(path: SchemaPath, message: string) {
  return { success: false as const, error: { path, message } };
}
function emptyEdges(): EdgeCollection {
  return { success: true, data: [] };
}
function pushEdges(pending: GraphFrame[], edges: readonly ChildEdge[]): void {
  for (let index = edges.length - 1; index >= 0; index--) {
    const edge = edges[index];
    if (edge !== undefined) pending.push({ kind: "enter", edge });
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
function isObjectNode(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
