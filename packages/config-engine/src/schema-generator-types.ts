import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

/** Schema input consumed by source/document generators. */
export interface ConfigurationSchemaEntry {
  readonly schema: ConfigurationPropertySchema;
}
