import { type Schema, Validator } from "@cfworker/json-schema";
import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { effectiveShadow } from "../defaults-shadow.js";
import { lowerSchema } from "../lower-schema.js";
import { normalizeErrors, prefixResult } from "../normalize.js";
import {
  baselinePatch,
  patchSegments,
  policyPreflight,
  resolvePatchSchemas,
} from "../preflight.js";
import type {
  CompiledValidation,
  SpikeMode,
  ValidationObservation,
  ValidatorAdapter,
} from "../types.js";

export function createCfworkerAdapter(): ValidatorAdapter {
  const registered = new Map<string, ConfigurationPropertySchema>();
  return {
    id: "cfworker",
    version: "4.1.1",
    capabilities: {
      composition: true,
      dynamicSchemas: true,
      interpreted: true,
      runtimeCodeGeneration: false,
    },
    compile: compileCfworker,
    validatePatch: (schema, path, value, options) =>
      validatePatch(schema, path, value, options),
    reset: () => registered.clear(),
    register: (id, schema) => timed(() => registered.set(id, schema)),
    validateRegistered: (id, value, mode) => {
      const schema = registered.get(id);
      return schema === undefined
        ? failure(`Unknown schema ${id}`)
        : compileCfworker(schema, mode).validate(value);
    },
  };
}

function compileCfworker(
  schema: ConfigurationPropertySchema,
  mode: SpikeMode,
): CompiledValidation {
  const preflight = policyPreflight(
    schema,
    mode === "effective" ? {} : undefined,
    mode,
  );
  if (
    preflight?.errors.some((error) => error.code === "invalid-schema") === true
  ) {
    return {
      compileMs: 0,
      validate: () => ({ normalized: preflight, raw: preflight.errors }),
    };
  }
  const start = performance.now();
  try {
    const lowered = lowerSchema(schema, mode);
    // lowerSchema emits a self-contained draft-7-compatible object graph.
    const validator = new Validator(lowered as unknown as Schema, "7", false);
    const compileMs = performance.now() - start;
    return {
      compileMs,
      validate: (value) => validateValue(validator, schema, value, mode),
    };
  } catch (error: unknown) {
    const failed = failure(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
    return { compileMs: performance.now() - start, validate: () => failed };
  }
}

function validateValue(
  validator: Validator,
  schema: ConfigurationPropertySchema,
  value: unknown,
  mode: SpikeMode,
): ValidationObservation {
  const policy = policyPreflight(schema, value, mode);
  if (policy !== undefined) return { normalized: policy, raw: policy.errors };
  try {
    const candidate =
      mode === "effective" ? effectiveShadow(schema, value) : value;
    const result = validator.validate(candidate);
    return {
      normalized: normalizeErrors(result.errors, schema),
      raw: result.errors,
    };
  } catch (error: unknown) {
    return failure(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
  }
}

function validatePatch(
  schema: ConfigurationPropertySchema,
  path: Parameters<ValidatorAdapter["validatePatch"]>[1],
  value: unknown,
  options: Parameters<ValidatorAdapter["validatePatch"]>[3],
): ValidationObservation {
  const boundary = baselinePatch(schema, path, value, options);
  if (
    boundary.errors.some(
      (error) =>
        error.code === "invalid-path" ||
        error.code === "unknown-property" ||
        error.code === "invalid-schema",
    )
  ) {
    return { normalized: boundary, raw: boundary.errors };
  }
  const targets = resolvePatchSchemas(schema, path, options);
  if (targets.length === 0)
    return { normalized: { valid: true, errors: [] }, raw: [] };
  const observations = targets.map((target) =>
    compileCfworker(target, "partial").validate(value),
  );
  const errors = observations.flatMap((item) => item.normalized.errors);
  const normalized = prefixResult(
    { valid: errors.length === 0, errors },
    patchSegments(path, options),
  );
  return { normalized, raw: observations.flatMap((item) => item.raw) };
}

function failure(message: string): ValidationObservation {
  return {
    normalized: {
      valid: false,
      errors: [{ code: "invalid-schema", path: "$", segments: [], message }],
    },
    raw: [message],
    threw: message,
  };
}

function timed(operation: () => void): number {
  const start = performance.now();
  operation();
  return performance.now() - start;
}
