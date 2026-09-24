import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
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

export function createAjvRuntimeAdapter(): ValidatorAdapter {
  const registered = new Map<string, ConfigurationPropertySchema>();
  return {
    id: "ajv-runtime",
    version: "8.20.0",
    capabilities: {
      composition: true,
      dynamicSchemas: true,
      interpreted: false,
      runtimeCodeGeneration: true,
    },
    compile: compileAjv,
    validatePatch: (schema, path, value, options) =>
      validatePatch(schema, path, value, options),
    reset: () => registered.clear(),
    register: (id, schema) => timed(() => registered.set(id, schema)),
    validateRegistered: (id, value, mode) => {
      const schema = registered.get(id);
      return schema === undefined
        ? failure(`Unknown schema ${id}`)
        : compileAjv(schema, mode).validate(value);
    },
  };
}

function compileAjv(
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
    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      useDefaults: false,
      coerceTypes: false,
      removeAdditional: false,
      code: { source: true },
    });
    const validate = ajv.compile(lowerSchema(schema, mode));
    return {
      compileMs: performance.now() - start,
      validate: (value) => validateValue(validate, schema, value, mode),
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
  validate: ValidateFunction,
  schema: ConfigurationPropertySchema,
  value: unknown,
  mode: SpikeMode,
): ValidationObservation {
  const policy = policyPreflight(schema, value, mode);
  if (policy !== undefined) return { normalized: policy, raw: policy.errors };
  try {
    const candidate =
      mode === "effective" ? effectiveShadow(schema, value) : value;
    validate(candidate);
    const errors: readonly ErrorObject[] = validate.errors ?? [];
    return { normalized: normalizeErrors(errors, schema), raw: errors };
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
  )
    return { normalized: boundary, raw: boundary.errors };
  const targets = resolvePatchSchemas(schema, path, options);
  if (targets.length === 0)
    return { normalized: { valid: true, errors: [] }, raw: [] };
  const observations = targets.map((target) =>
    compileAjv(target, "partial").validate(value),
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
