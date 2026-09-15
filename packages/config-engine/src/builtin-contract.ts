import {
  type BuiltinCodeContract,
  createWeaverError,
  getBuiltinCatalogSource,
  visitConfigurationSchemas,
} from "@weaver-conf/config-types";
import { validateConfigurationDefaults } from "./schema-default-validation";
import { materializeConfigurationDefaults } from "./schema-defaults";

/** Compiles a trusted executable contract; default annotations never substitute for strict validation. */
export function compileBuiltinContract<T>(
  definition: BuiltinCodeContract<T>,
): (input: unknown) => T {
  const parsedDefaults =
    getBuiltinCatalogSource().contracts.defaultAnnotations.schema.safeParse(
      definition.defaults,
    );
  if (!parsedDefaults.success)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Unsupported built-in default annotations",
    );
  const defaults = parsedDefaults.data;
  const validation = validateConfigurationDefaults(defaults);
  if (!validation.valid)
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Invalid built-in defaults at ${definition.path}`,
      { errors: validation.errors },
    );
  const parse = definition.schema.safeParse;
  validateContractDefaults(definition, defaults);
  return (input: unknown): T => {
    const candidate = materializeBuiltinInput(defaults, input);
    const parsed = parse(candidate);
    if (!parsed.success)
      throw createWeaverError(
        "VALIDATION_ERROR",
        `Invalid built-in value at ${definition.path}`,
        {
          issues: parsed.error.issues.map(({ path, message }) => ({
            path,
            message,
          })),
        },
      );
    return parsed.data;
  };
}

function validateContractDefaults<T>(
  definition: BuiltinCodeContract<T>,
  defaults: BuiltinCodeContract<T>["defaults"],
): void {
  visitConfigurationSchemas(defaults, (node, path) => {
    if (!Object.hasOwn(node, "default")) return;
    const value = materializeConfigurationDefaults(node, node.default, false);
    if (!definition.schema.acceptsDefault(path, value))
      throw createWeaverError(
        "VALIDATION_ERROR",
        `Built-in default violates strict contract at ${definition.path}: ${JSON.stringify(path)}`,
      );
  });
}

function materializeBuiltinInput(
  defaults: BuiltinCodeContract<unknown>["defaults"],
  input: unknown,
): unknown {
  try {
    return materializeConfigurationDefaults(defaults, input, false);
  } catch {
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Built-in input must be serializable configuration",
    );
  }
}
