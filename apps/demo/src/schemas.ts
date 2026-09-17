import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

const schemas = new Map<string, ConfigurationPropertySchema>([
  [
    "app.ui.theme",
    {
      type: "string",
      description: "UI theme preference",
      enum: ["light", "dark", "system"],
      "x-weaver": { changePolicy: "direct-allowed", visibility: "public" },
    },
  ],
  [
    "app.ui.language",
    {
      type: "string",
      description: "Interface language — locked at tenant",
      "x-weaver": {
        maxOverrideLayer: "tenant",
        changePolicy: "staging-gate",
        visibility: "public",
      },
    },
  ],
  [
    "app.ui.sidebar.collapsed",
    {
      type: "boolean",
      description: "Sidebar collapsed state",
      "x-weaver": { changePolicy: "direct-allowed", visibility: "public" },
    },
  ],
  [
    "app.ui.font.size",
    {
      type: "number",
      description: "Font size in pixels",
      minimum: 8,
      maximum: 32,
      "x-weaver": { changePolicy: "direct-allowed", visibility: "public" },
    },
  ],
  [
    "app.ui.font.family",
    {
      type: "string",
      description: "Font family — platform locked",
      "x-weaver": {
        maxOverrideLayer: "app",
        changePolicy: "full-pipeline",
        visibility: "admin",
      },
    },
  ],
  [
    "app.feature.analytics.enabled",
    {
      type: "boolean",
      description: "Analytics toggle — requires staging",
      "x-weaver": {
        maxOverrideLayer: "tenant",
        changePolicy: "staging-gate",
        visibility: "admin",
      },
    },
  ],
  [
    "app.feature.notifications.enabled",
    {
      type: "boolean",
      description: "Notification toggle",
      "x-weaver": { changePolicy: "direct-allowed", visibility: "public" },
    },
  ],
  [
    "app.feature.notifications.frequency",
    {
      type: "string",
      description: "Notification frequency",
      enum: ["realtime", "hourly", "daily", "weekly"],
      "x-weaver": { changePolicy: "direct-allowed", visibility: "public" },
    },
  ],
  [
    "app.network.timeout.ms",
    {
      type: "number",
      description: "Timeout — emergency only",
      minimum: 1000,
      maximum: 60000,
      "x-weaver": {
        maxOverrideLayer: "tenant",
        changePolicy: "emergency-override",
        visibility: "internal",
      },
    },
  ],
  [
    "app.network.retry.count",
    {
      type: "number",
      description: "Retry count — pipeline locked",
      minimum: 0,
      maximum: 10,
      "x-weaver": {
        maxOverrideLayer: "app",
        changePolicy: "full-pipeline",
        visibility: "internal",
      },
    },
  ],
]);

/** Schema metadata with weaver extensions flattened for UI convenience. */
export interface DemoSchemaInfo {
  description?: string | undefined;
  changePolicy?: string | undefined;
  maxOverrideLayer?: string | undefined;
  visibility?: string | undefined;
}

export function getSchemaForKey(key: string): DemoSchemaInfo | undefined {
  const schema = schemas.get(key);
  if (!schema) return undefined;
  return {
    description: schema.description,
    changePolicy: schema["x-weaver"]?.changePolicy,
    maxOverrideLayer: schema["x-weaver"]?.maxOverrideLayer,
    visibility: schema["x-weaver"]?.visibility,
  };
}

/** Get the full ConfigurationPropertySchema for policy evaluation. */
export function getFullSchemaForKey(
  key: string,
): ConfigurationPropertySchema | undefined {
  return schemas.get(key);
}
