import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import type { SpikeMode } from "./types.js";

interface CloneFrame {
  readonly source: ConfigurationPropertySchema;
  readonly target: Record<string, unknown>;
}

const CHILD_MAPS = ["properties", "patternProperties"] as const;
const CHILD_ARRAYS = ["oneOf", "anyOf", "allOf"] as const;

export function lowerSchema(
  schema: ConfigurationPropertySchema,
  mode: SpikeMode,
): ConfigurationPropertySchema {
  const root: Record<string, unknown> = {};
  const clones = new WeakMap<object, Record<string, unknown>>([[schema, root]]);
  const pending: CloneFrame[] = [{ source: schema, target: root }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
    copyScalarKeywords(frame, mode);
    copySchemaChildren(frame, pending, clones);
    if (
      allowsObject(frame.source) &&
      frame.source.additionalProperties === undefined
    ) {
      frame.target.additionalProperties = false;
    }
  }
  // The iterative copier only emits the ConfigurationPropertySchema keyword set.
  return root as unknown as ConfigurationPropertySchema;
}

function copyScalarKeywords(frame: CloneFrame, mode: SpikeMode): void {
  for (const key of Object.keys(frame.source)) {
    if (mode === "partial" && (key === "required" || key === "minProperties"))
      continue;
    if (isChildKeyword(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
    if (descriptor !== undefined && "value" in descriptor) {
      Object.defineProperty(
        frame.target,
        key,
        dataDescriptor(descriptor.value),
      );
    }
  }
}

function copySchemaChildren(
  frame: CloneFrame,
  pending: CloneFrame[],
  clones: WeakMap<object, Record<string, unknown>>,
): void {
  for (const key of CHILD_MAPS) copySchemaMap(frame, key, pending, clones);
  copyAdditional(frame, pending, clones);
  copyItems(frame, pending, clones);
  for (const key of CHILD_ARRAYS) copySchemaArray(frame, key, pending, clones);
  if (frame.source.not !== undefined) {
    frame.target.not = cloneChild(frame.source.not, pending, clones);
  }
}

function copySchemaMap(
  frame: CloneFrame,
  key: (typeof CHILD_MAPS)[number],
  pending: CloneFrame[],
  clones: WeakMap<object, Record<string, unknown>>,
): void {
  const sourceMap = frame.source[key];
  if (sourceMap === undefined) return;
  const targetMap: Record<string, unknown> = Object.create(null);
  for (const name of Object.keys(sourceMap)) {
    const descriptor = Object.getOwnPropertyDescriptor(sourceMap, name);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    const child = descriptor.value;
    Object.defineProperty(
      targetMap,
      name,
      dataDescriptor(cloneChild(child, pending, clones)),
    );
  }
  frame.target[key] = targetMap;
}

function copyAdditional(
  frame: CloneFrame,
  pending: CloneFrame[],
  clones: WeakMap<object, Record<string, unknown>>,
): void {
  const child = frame.source.additionalProperties;
  if (typeof child === "object" && child !== null) {
    frame.target.additionalProperties = cloneChild(child, pending, clones);
  }
}

function copyItems(
  frame: CloneFrame,
  pending: CloneFrame[],
  clones: WeakMap<object, Record<string, unknown>>,
): void {
  const items = frame.source.items;
  if (items === undefined) return;
  frame.target.items = isSchemaArray(items)
    ? items.map((item) => cloneChild(item, pending, clones))
    : cloneChild(items, pending, clones);
}

function isSchemaArray(
  value: ConfigurationPropertySchema | readonly ConfigurationPropertySchema[],
): value is readonly ConfigurationPropertySchema[] {
  return Array.isArray(value);
}

function copySchemaArray(
  frame: CloneFrame,
  key: (typeof CHILD_ARRAYS)[number],
  pending: CloneFrame[],
  clones: WeakMap<object, Record<string, unknown>>,
): void {
  const children = frame.source[key];
  if (children !== undefined) {
    frame.target[key] = children.map((child) =>
      cloneChild(child, pending, clones),
    );
  }
}

function cloneChild(
  source: ConfigurationPropertySchema,
  pending: CloneFrame[],
  clones: WeakMap<object, Record<string, unknown>>,
): Record<string, unknown> {
  const existing = clones.get(source);
  if (existing !== undefined) return existing;
  const target: Record<string, unknown> = {};
  clones.set(source, target);
  pending.push({ source, target });
  return target;
}

function allowsObject(schema: ConfigurationPropertySchema): boolean {
  return (
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object"))
  );
}

function isChildKeyword(key: string): boolean {
  return (
    key === "properties" ||
    key === "patternProperties" ||
    key === "additionalProperties" ||
    key === "items" ||
    key === "oneOf" ||
    key === "anyOf" ||
    key === "allOf" ||
    key === "not"
  );
}

function dataDescriptor(value: unknown): PropertyDescriptor {
  return { value, enumerable: true, configurable: true, writable: true };
}
