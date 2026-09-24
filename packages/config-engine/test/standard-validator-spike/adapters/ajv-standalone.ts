import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import Ajv, { type ValidateFunction } from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { lowerSchema } from "../lower-schema.js";
import { normalizeErrors } from "../normalize.js";
import { policyPreflight } from "../preflight.js";
import type {
  CompiledValidation,
  SpikeMode,
  ValidationObservation,
  ValidatorAdapter,
} from "../types.js";

const FIXED_SCHEMA: ConfigurationPropertySchema = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string", minLength: 1 } },
};

export function createAjvStandaloneAdapter(): ValidatorAdapter {
  const fixed = compileStandalone(FIXED_SCHEMA, "effective");
  return {
    id: "ajv-standalone",
    version: "8.20.0",
    capabilities: {
      composition: true,
      dynamicSchemas: false,
      interpreted: false,
      runtimeCodeGeneration: false,
    },
    compile: (schema, mode) =>
      schema === FIXED_SCHEMA
        ? compileStandalone(schema, mode)
        : unavailable("Standalone requires build-time schema generation"),
    validatePatch: () =>
      failure("Standalone cannot resolve an unseen runtime patch schema"),
    reset: () => undefined,
    register: () => Number.POSITIVE_INFINITY,
    validateRegistered: (id, value) =>
      id === "fixed"
        ? fixed.validate(value)
        : failure("Standalone cannot register unseen runtime schemas"),
  };
}

export function generateStandaloneModule(
  schema: ConfigurationPropertySchema,
): string {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    code: { source: true, esm: true },
  });
  const validate = ajv.compile(lowerSchema(schema, "effective"));
  return standaloneCode(ajv, validate);
}

export function fixedStandaloneSchema(): ConfigurationPropertySchema {
  return FIXED_SCHEMA;
}

function compileStandalone(
  schema: ConfigurationPropertySchema,
  mode: SpikeMode,
): CompiledValidation {
  const start = performance.now();
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    code: { source: true },
  });
  const validate = ajv.compile(lowerSchema(schema, mode));
  return {
    compileMs: performance.now() - start,
    validate: (value) => observe(validate, schema, value, mode),
  };
}

function observe(
  validate: ValidateFunction,
  schema: ConfigurationPropertySchema,
  value: unknown,
  mode: SpikeMode,
): ValidationObservation {
  const policy = policyPreflight(schema, value, mode);
  if (policy !== undefined) return { normalized: policy, raw: policy.errors };
  validate(value);
  const raw = validate.errors ?? [];
  return { normalized: normalizeErrors(raw, schema), raw };
}

function unavailable(message: string): CompiledValidation {
  return {
    compileMs: Number.POSITIVE_INFINITY,
    validate: () => failure(message),
  };
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
