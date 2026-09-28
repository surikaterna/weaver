import {
  type ConfigurationPropertySchema,
  registeredSchemasResponseSchema,
} from "@weaver-conf/config-types";

export const SCHEMA_FIXTURES = [
  {
    label: "Service / namespace object",
    kind: "service",
    anchor: "/app",
    environment: "default",
    key: "/app:default",
    schema: {
      type: "object",
      description: "Offline example of a complete app service schema",
      required: ["ui", "network"],
      additionalProperties: false,
      properties: {
        ui: {
          type: "object",
          required: ["theme"],
          properties: {
            theme: {
              type: "string",
              enum: ["light", "dark", "system"],
              "x-weaver": {
                changePolicy: "direct-allowed",
                visibility: "public",
              },
            },
            font: {
              type: "object",
              properties: { size: { type: "number", minimum: 8, maximum: 32 } },
            },
          },
        },
        network: {
          type: "object",
          properties: { timeout: { type: "number", minimum: 1000 } },
        },
      },
    },
  },
  {
    label: "Fragment object (declared slot: /app/plugins/demo.notifications)",
    kind: "fragment",
    anchor: "/app/plugins/demo.notifications",
    environment: "default",
    key: "/app/plugins/demo.notifications:default",
    schema: {
      type: "object",
      description: "Separately declared notifications plugin fragment",
      required: ["enabled"],
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
        frequency: {
          type: "string",
          enum: ["realtime", "hourly", "daily"],
          "x-weaver": { changePolicy: "staging-gate", visibility: "admin" },
        },
      },
    },
  },
] as const;

export function registeredSchemaFixtures(): Record<
  string,
  ConfigurationPropertySchema
> {
  const schemas = Object.fromEntries(
    SCHEMA_FIXTURES.map(({ key, schema }) => [key, structuredClone(schema)]),
  );
  return registeredSchemasResponseSchema.parse({ schemas }).schemas;
}
