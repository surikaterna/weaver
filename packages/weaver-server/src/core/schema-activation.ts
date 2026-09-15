import { deepEqual, detectBreakingChanges } from "@weaver-conf/config-engine";
import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

/** Advisory only. Unanalysed differences never establish compatibility. */
export function schemaCompatibility(
  before: ConfigurationPropertySchema,
  after: ConfigurationPropertySchema,
) {
  if (deepEqual(before, after))
    return {
      compatibility: "compatible" as const,
      hasBreakingChanges: false,
      breakingChanges: [],
    };
  const changes = detectBreakingChanges(before, after);
  return {
    compatibility: changes.length
      ? ("breaking" as const)
      : ("unknown" as const),
    hasBreakingChanges: true,
    breakingChanges: changes.map((change) => change.message),
  };
}
