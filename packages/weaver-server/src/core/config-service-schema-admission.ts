import {
  parseCanonicalConfigPath,
  type SchemaValidationResult,
} from "@weaver-conf/config-engine";
import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { validationFailure } from "./config-service-schema-errors";
import type {
  FailedSchemaWrite,
  ResolvedWriteAnchor,
} from "./config-service-schema-writes";
import type { RegisteredSchemaAnchor } from "./schema-registry";

type Admission =
  | { readonly success: true; readonly schema: ConfigurationPropertySchema }
  | { readonly success: false; readonly validation: SchemaValidationResult };
type Frame =
  | { readonly leave: true; readonly value: object }
  | { readonly leave: false; readonly value: unknown };

// Admit the original reference at each I/O seam; domain semantics belong to the engine.
export function admitAnchorSchema(
  anchor: RegisteredSchemaAnchor,
  segments: readonly string[],
): Admission {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(anchor, "schema");
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      return unsafeSchema(segments);
    const schema: ConfigurationPropertySchema = descriptor.value;
    if (!plainRecord(schema) || !ownDataGraph(schema))
      return unsafeSchema(segments);
    return { success: true, schema };
  } catch {
    return unsafeSchema(segments);
  }
}

export function admitWriteSchema(
  resolved: ResolvedWriteAnchor,
): Extract<Admission, { success: true }> | FailedSchemaWrite {
  try {
    const path = ownAnchorPath(resolved.anchor);
    if (path === undefined) return unsafeAnchor(resolved);
    const admitted = admitAnchorSchema(
      resolved.anchor,
      parseCanonicalConfigPath(path).segments,
    );
    return admitted.success
      ? admitted
      : validationFailure(admitted.validation, resolved);
  } catch {
    return unsafeAnchor(resolved);
  }
}

export function unsafeAnchor(resolved: ResolvedWriteAnchor): FailedSchemaWrite {
  return {
    success: false,
    result: {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Configuration does not match registered schema",
        details: {
          path: resolved.path,
          anchorPath: resolved.path,
          environment: resolved.environment,
          errors: unsafeSchema(resolved.segments).validation.errors,
        },
      },
    },
  };
}

export function unsafeSchema(
  segments: readonly string[],
): Extract<Admission, { success: false }> {
  return {
    success: false,
    validation: {
      valid: false,
      errors: [
        {
          code: "invalid-schema",
          segments: [...segments],
          path: segments.reduce(
            (path, segment) =>
              path +
              (/^[A-Za-z_$][\w$-]*$/.test(segment)
                ? `.${segment}`
                : `[${JSON.stringify(segment)}]`),
            "$",
          ),
          message: "Schema must contain only acyclic own plain data",
        },
      ],
    },
  };
}

export function ownAnchorPath(
  anchor: RegisteredSchemaAnchor,
): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(anchor, "path");
    const path: unknown =
      descriptor && Object.hasOwn(descriptor, "value")
        ? descriptor.value
        : undefined;
    return typeof path === "string" ? path : undefined;
  } catch {
    return undefined;
  }
}

function ownDataGraph(schema: object): boolean {
  const active = new Set<object>(),
    completed = new Set<object>();
  const pending: Frame[] = [{ leave: false, value: schema }];
  while (pending.length) {
    const frame = pending.pop();
    if (!frame) continue;
    if (frame.leave) {
      active.delete(frame.value);
      completed.add(frame.value);
      continue;
    }
    const value = frame.value;
    if (value === null || typeof value !== "object") {
      if (
        !["undefined", "string", "number", "boolean"].includes(typeof value) &&
        value !== null
      )
        return false;
      continue;
    }
    if (active.has(value) || !plainContainer(value)) return false;
    if (completed.has(value)) continue;
    active.add(value);
    pending.push({ leave: true, value });
    if (!queueDescriptors(value, pending)) return false;
  }
  return true;
}

function queueDescriptors(value: object, pending: Frame[]): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return false;
    pending.push({ leave: false, value: descriptor.value });
  }
  return true;
}

function plainRecord(value: unknown): value is object {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    plainContainer(value)
  );
}

function plainContainer(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
}
