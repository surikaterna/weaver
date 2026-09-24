import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import type { SchemaValidationResult } from "../../../src/schema-validation.js";
import { baselinePatch, baselineValidate } from "../preflight.js";
import type {
  CompiledValidation,
  SpikeMode,
  ValidationObservation,
  ValidatorAdapter,
} from "../types.js";

export function createBaselineAdapter(): ValidatorAdapter {
  const registered = new Map<string, ConfigurationPropertySchema>();
  return {
    id: "baseline",
    version: "4fe70d70762460d6656641bfa775121c4ffae058",
    capabilities: {
      composition: false,
      dynamicSchemas: true,
      interpreted: true,
      runtimeCodeGeneration: false,
    },
    compile: (schema, mode) => compileBaseline(schema, mode),
    validatePatch: (schema, path, value, options) =>
      observation(baselinePatch(schema, path, value, options)),
    reset: () => registered.clear(),
    register: (id, schema) => timed(() => registered.set(id, schema)),
    validateRegistered: (id, value, mode) => {
      const schema = registered.get(id);
      return schema === undefined
        ? failure(`Unknown schema ${id}`)
        : observation(baselineValidate(schema, value, mode));
    },
  };
}

function compileBaseline(
  schema: ConfigurationPropertySchema,
  mode: SpikeMode,
): CompiledValidation {
  const start = performance.now();
  const validate = (value: unknown): ValidationObservation =>
    observation(baselineValidate(schema, value, mode));
  return { compileMs: performance.now() - start, validate };
}

function observation(
  normalized: SchemaValidationResult,
): ValidationObservation {
  return { normalized, raw: normalized.errors };
}

function failure(message: string): ValidationObservation {
  return {
    normalized: {
      valid: false,
      errors: [{ code: "invalid-schema", path: "$", segments: [], message }],
    },
    raw: [message],
  };
}

function timed(operation: () => void): number {
  const start = performance.now();
  operation();
  return performance.now() - start;
}
