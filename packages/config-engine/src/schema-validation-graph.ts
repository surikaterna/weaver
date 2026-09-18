import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  addContextError,
  appendValidationPath,
  isSchemaArray,
  type SchemaValidationPathSegment,
  type ValidationContext,
  type ValidationPath,
} from "./schema-validation-support";

interface SchemaInspection {
  readonly cyclic: boolean;
  readonly nodes: readonly ConfigurationPropertySchema[];
}

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
  const inspection = inspectSchemaGraph(schema);
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
): SchemaInspection {
  const active = new WeakSet<object>();
  const completed = new WeakSet<object>();
  const nodes: ConfigurationPropertySchema[] = [];
  const pending: GraphFrame<ConfigurationPropertySchema>[] = [
    { kind: "enter", value: root },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      completed.add(frame.value);
      continue;
    }
    if (active.has(frame.value)) return { cyclic: true, nodes };
    if (completed.has(frame.value)) continue;
    active.add(frame.value);
    nodes.push(frame.value);
    pending.push({ kind: "exit", value: frame.value });
    pushSchemaChildren(frame.value, pending);
  }
  return { cyclic: false, nodes };
}

function pushSchemaChildren(
  schema: ConfigurationPropertySchema,
  pending: GraphFrame<ConfigurationPropertySchema>[],
): void {
  const children: ConfigurationPropertySchema[] = [];
  children.push(...Object.values(schema.properties ?? {}));
  children.push(...Object.values(schema.patternProperties ?? {}));
  if (typeof schema.additionalProperties === "object") {
    children.push(schema.additionalProperties);
  }
  if (schema.items !== undefined) {
    if (isSchemaArray(schema.items)) children.push(...schema.items);
    else children.push(schema.items);
  }
  children.push(...(schema.oneOf ?? []), ...(schema.anyOf ?? []));
  children.push(...(schema.allOf ?? []));
  if (schema.not !== undefined) children.push(schema.not);
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (child !== undefined) pending.push({ kind: "enter", value: child });
  }
}

function schemaConstraintRoots(
  nodes: readonly ConfigurationPropertySchema[],
): readonly unknown[] {
  const roots: unknown[] = [];
  for (const schema of nodes) {
    if (schema.default !== undefined) roots.push(schema.default);
    if (schema.const !== undefined) roots.push(schema.const);
    if (schema.enum !== undefined) roots.push(schema.enum);
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
