import { createSchemaRegistry } from "@weaver-conf/config-engine";
import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";

export const schemaRegistry = createSchemaRegistry();

// Register UI namespace schemas
schemaRegistry.register({
  ownerId: "demo-ui",
  namespace: "app.ui",
  properties: {
    theme: {
      type: "string",
      description: "UI theme preference",
      enum: ["light", "dark", "system"],
      "x-weaver": { changePolicy: "direct-allowed", visibility: "public" },
    },
    language: {
      type: "string",
      description: "Interface language — locked at tenant",
      "x-weaver": {
        maxOverrideLayer: "tenant",
        changePolicy: "staging-gate",
        visibility: "public",
      },
    },
    "sidebar.collapsed": {
      type: "boolean",
      description: "Sidebar collapsed state",
      "x-weaver": { changePolicy: "direct-allowed", visibility: "public" },
    },
    "font.size": {
      type: "number",
      description: "Font size in pixels",
      minimum: 8,
      maximum: 32,
      "x-weaver": { changePolicy: "direct-allowed", visibility: "public" },
    },
    "font.family": {
      type: "string",
      description: "Font family — platform locked",
      "x-weaver": {
        maxOverrideLayer: "app",
        changePolicy: "full-pipeline",
        visibility: "admin",
      },
    },
  },
});

// Register feature namespace schemas
schemaRegistry.register({
  ownerId: "demo-feature",
  namespace: "app.feature",
  properties: {
    "analytics.enabled": {
      type: "boolean",
      description: "Analytics toggle — requires staging",
      "x-weaver": {
        maxOverrideLayer: "tenant",
        changePolicy: "staging-gate",
        visibility: "admin",
      },
    },
    "notifications.enabled": {
      type: "boolean",
      description: "Notification toggle",
      "x-weaver": { changePolicy: "direct-allowed", visibility: "public" },
    },
    "notifications.frequency": {
      type: "string",
      description: "Notification frequency",
      enum: ["realtime", "hourly", "daily", "weekly"],
      "x-weaver": { changePolicy: "direct-allowed", visibility: "public" },
    },
  },
});

// Register network namespace schemas
schemaRegistry.register({
  ownerId: "demo-network",
  namespace: "app.network",
  properties: {
    "timeout.ms": {
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
    "retry.count": {
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
  },
});

/** Schema metadata with weaver extensions flattened for UI convenience. */
export interface DemoSchemaInfo {
  description?: string | undefined;
  changePolicy?: string | undefined;
  maxOverrideLayer?: string | undefined;
  visibility?: string | undefined;
}

export function getSchemaForKey(key: string): DemoSchemaInfo | undefined {
  const entry = schemaRegistry.getSchema(key);
  if (!entry) return undefined;
  const s = entry.schema;
  return {
    description: s.description,
    changePolicy: s["x-weaver"]?.changePolicy,
    maxOverrideLayer: s["x-weaver"]?.maxOverrideLayer,
    visibility: s["x-weaver"]?.visibility,
  };
}

/** Get the full ConfigurationPropertySchema for policy evaluation. */
export function getFullSchemaForKey(
  key: string,
): ConfigurationPropertySchema | undefined {
  return schemaRegistry.getSchema(key)?.schema;
}
