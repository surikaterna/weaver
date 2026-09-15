import { validateConfigurationDefaults } from "@weaver-conf/config-engine";
import {
  type ConfigurationPropertySchema,
  createWeaverError,
} from "@weaver-conf/config-types";

export function assertValidSchemaDefaults(
  schema: ConfigurationPropertySchema,
): void {
  try {
    const result = validateConfigurationDefaults(schema);
    if (result.valid) return;
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Registered schema has invalid defaults: ${result.errors.map((error) => error.message).join("; ")}`,
      { errors: result.errors },
    );
  } catch (error: unknown) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Invalid schema defaults: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
