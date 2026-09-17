import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

import {
  addContextError,
  type SchemaValidationPathSegment,
  type ValidationContext,
} from "./schema-validation-support";

const COMPOSITION_KEYWORDS = ["oneOf", "anyOf", "allOf", "not"] as const;

export function rejectUnsupportedComposition(
  schema: ConfigurationPropertySchema,
  path: readonly SchemaValidationPathSegment[],
  context: ValidationContext,
): boolean {
  const keywords = COMPOSITION_KEYWORDS.filter(
    (keyword) => schema[keyword] !== undefined,
  );
  if (keywords.length === 0) return false;

  addContextError(context, "invalid-schema", path, {
    message: `Unsupported composition keyword(s): ${keywords.join(", ")}`,
  });
  return true;
}
