import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  getCompositionEntries,
  isSupportedSchema,
  validateCompositionShape,
} from "./schema-validation-composition";
import {
  addContextError,
  appendValidationPath,
  compileSchemaPattern,
  isSchemaArray,
  type SchemaValidationPathSegment,
  type ValidationContext,
  type ValidationPath,
} from "./schema-validation-support";

interface SchemaInspection {
  readonly cyclic: boolean;
  readonly valid: boolean;
  readonly nodes: readonly ConfigurationPropertySchema[];
}

type SchemaGraphFrame =
  | {
      readonly kind: "enter";
      readonly value: unknown;
      readonly invalidMessage: string;
    }
  | { readonly kind: "exit"; readonly value: ConfigurationPropertySchema };

type GraphFrame<T extends object> =
  | { readonly kind: "enter"; readonly value: T }
  | { readonly kind: "exit"; readonly value: T };

type ValueCycleFrame =
  | {
      readonly kind: "enter";
      readonly value: unknown;
      readonly path: ValidationPath;
    }
  | { readonly kind: "exit"; readonly value: object };

export function validateSchemaGraph(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  const inspection = inspectSchemaGraph(schema, path, context);
  if (!inspection.valid) return false;
  const constraintCycle = hasObjectCycle(
    schemaConstraintRoots(inspection.nodes),
  );
  if (!inspection.cyclic && !constraintCycle) return true;
  addContextError(context, "invalid-schema", path, {
    message: inspection.cyclic
      ? "Schema must not contain cycles"
      : "Schema constraint values must not contain cycles",
  });
  return false;
}

export function validateValueGraph(
  value: unknown,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  const cyclePath = findValueCycle(value, path);
  if (cyclePath === undefined) return true;
  addContextError(context, "invalid-value", cyclePath, {
    message: "Configuration values must not contain cycles",
  });
  return false;
}

function inspectSchemaGraph(
  root: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): SchemaInspection {
  const active = new WeakSet<object>();
  const completed = new WeakSet<object>();
  const nodes: ConfigurationPropertySchema[] = [];
  const pending: SchemaGraphFrame[] = [
    {
      kind: "enter",
      value: root,
      invalidMessage: "Schema must have a supported non-empty type",
    },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      completed.add(frame.value);
      continue;
    }
    if (!isSupportedSchema(frame.value)) {
      addContextError(context, "invalid-schema", path, {
        message: frame.invalidMessage,
      });
      return { cyclic: false, valid: false, nodes };
    }
    const schema = frame.value;
    if (active.has(schema)) return { cyclic: true, valid: true, nodes };
    if (completed.has(schema)) continue;
    if (!validateSchemaNode(schema, path, context))
      return { cyclic: false, valid: false, nodes };
    active.add(schema);
    nodes.push(schema);
    pending.push({ kind: "exit", value: schema });
    pushSchemaChildren(schema, pending);
  }
  return { cyclic: false, valid: true, nodes };
}

function pushSchemaChildren(
  schema: ConfigurationPropertySchema,
  pending: SchemaGraphFrame[],
): void {
  const children: Extract<SchemaGraphFrame, { kind: "enter" }>[] = [];
  pushSchemaMapChildren(schema, "properties", children);
  pushSchemaMapChildren(schema, "patternProperties", children);
  const additional = Object.hasOwn(schema, "additionalProperties")
    ? schema.additionalProperties
    : undefined;
  if (additional !== undefined && typeof additional !== "boolean") {
    children.push({
      kind: "enter",
      value: additional,
      invalidMessage:
        "additionalProperties must be a boolean or schema object with a supported non-empty type",
    });
  }
  pushItemChildren(schema, children);
  for (const entry of getCompositionEntries(schema)) {
    for (let index = 0; index < entry.branches.length; index++) {
      const branch = entry.branches[index];
      if (branch === undefined) continue;
      children.push({
        kind: "enter",
        value: branch,
        invalidMessage:
          entry.keyword === "not"
            ? "not must be a schema object with a supported non-empty type"
            : `${entry.keyword} branch ${String(index)} must be a schema object with a supported non-empty type`,
      });
    }
  }
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (child !== undefined) pending.push(child);
  }
}

function pushSchemaMapChildren(
  schema: ConfigurationPropertySchema,
  key: "properties" | "patternProperties",
  children: Extract<SchemaGraphFrame, { kind: "enter" }>[],
): void {
  if (!Object.hasOwn(schema, key)) return;
  const map = schema[key];
  if (map === undefined) return;
  for (const [name, child] of Object.entries(map)) {
    children.push({
      kind: "enter",
      value: child,
      invalidMessage: `${key} entry ${JSON.stringify(name)} must be a schema object with a supported non-empty type`,
    });
  }
}

function pushItemChildren(
  schema: ConfigurationPropertySchema,
  children: Extract<SchemaGraphFrame, { kind: "enter" }>[],
): void {
  if (!Object.hasOwn(schema, "items") || schema.items === undefined) return;
  if (!isSchemaArray(schema.items)) {
    children.push({
      kind: "enter",
      value: schema.items,
      invalidMessage:
        "items must be a schema object or dense array of schema objects with supported non-empty types",
    });
    return;
  }
  for (let index = 0; index < schema.items.length; index++) {
    children.push({
      kind: "enter",
      value: Object.hasOwn(schema.items, index)
        ? schema.items[index]
        : undefined,
      invalidMessage: `items entry ${String(index)} must be a schema object with a supported non-empty type`,
    });
  }
}

function validateSchemaNode(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  if (!isSupportedSchema(schema)) {
    addContextError(context, "invalid-schema", path, {
      message: "Schema must have a supported non-empty type",
    });
    return false;
  }
  if (!validateCompositionShape(schema, path, context)) return false;
  if (!validateMultipleOfDefinition(schema, path, context)) return false;
  if (!validatePatternDefinition(schema, path, context)) return false;
  return validatePatternProperties(schema, path, context);
}

function validateMultipleOfDefinition(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  if (!Object.hasOwn(schema, "multipleOf")) return true;
  const divisor = schema.multipleOf;
  if (divisor === undefined || (Number.isFinite(divisor) && divisor > 0)) {
    return true;
  }
  addContextError(context, "invalid-schema", path, {
    message: "multipleOf must be positive and finite",
  });
  return false;
}

function validatePatternDefinition(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  if (!Object.hasOwn(schema, "pattern") || schema.pattern === undefined) {
    return true;
  }
  return compileSchemaPattern(schema.pattern, path, context) !== undefined;
}

function validatePatternProperties(
  schema: ConfigurationPropertySchema,
  path: ValidationPath,
  context: ValidationContext,
): boolean {
  if (!Object.hasOwn(schema, "patternProperties")) return true;
  const patterns = schema.patternProperties;
  if (patterns === undefined) return true;
  for (const pattern of Object.keys(patterns)) {
    if (compileSchemaPattern(pattern, path, context) === undefined)
      return false;
  }
  return true;
}

function schemaConstraintRoots(
  nodes: readonly ConfigurationPropertySchema[],
): readonly unknown[] {
  const roots: unknown[] = [];
  for (const schema of nodes) {
    if (Object.hasOwn(schema, "default") && schema.default !== undefined)
      roots.push(schema.default);
    if (Object.hasOwn(schema, "const") && schema.const !== undefined)
      roots.push(schema.const);
    if (Object.hasOwn(schema, "enum") && schema.enum !== undefined)
      roots.push(schema.enum);
  }
  return roots;
}

function hasObjectCycle(roots: readonly unknown[]): boolean {
  const active = new WeakSet<object>();
  const completed = new WeakSet<object>();
  const pending: GraphFrame<object>[] = [];
  for (let index = roots.length - 1; index >= 0; index--) {
    const root = roots[index];
    if (isObjectValue(root)) pending.push({ kind: "enter", value: root });
  }
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      completed.add(frame.value);
      continue;
    }
    if (active.has(frame.value)) return true;
    if (completed.has(frame.value)) continue;
    active.add(frame.value);
    pending.push({ kind: "exit", value: frame.value });
    pushObjectChildren(frame.value, pending);
  }
  return false;
}

function pushObjectChildren(
  value: object,
  pending: GraphFrame<object>[],
): void {
  const children = Object.values(value);
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (isObjectValue(child)) pending.push({ kind: "enter", value: child });
  }
}

function findValueCycle(
  value: unknown,
  path: ValidationPath,
): ValidationPath | undefined {
  const active = new WeakSet<object>();
  const completed = new WeakSet<object>();
  const pending: ValueCycleFrame[] = [{ kind: "enter", value, path }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      completed.add(frame.value);
      continue;
    }
    if (!isObjectValue(frame.value)) continue;
    if (active.has(frame.value)) return frame.path;
    if (completed.has(frame.value)) continue;
    active.add(frame.value);
    pending.push({ kind: "exit", value: frame.value });
    pushValueChildren(frame.value, frame.path, pending);
  }
  return undefined;
}

function pushValueChildren(
  value: object,
  path: ValidationPath,
  pending: ValueCycleFrame[],
): void {
  const entries = Object.entries(value);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry === undefined) continue;
    pending.push({
      kind: "enter",
      value: entry[1],
      path: appendValidationPath(path, valuePathSegment(value, entry[0])),
    });
  }
}

function valuePathSegment(
  parent: object,
  key: string,
): SchemaValidationPathSegment {
  if (!Array.isArray(parent) || !/^(?:0|[1-9][0-9]*)$/.test(key)) return key;
  const index = Number(key);
  return Number.isSafeInteger(index) && index <= 4_294_967_294 ? index : key;
}

function isObjectValue(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
