import {
  type ConfigurationPropertySchema,
  createWeaverError,
  type RegisteredSchemaDetailResponse,
  registeredSchemaDetailRequestSchema,
  registeredSchemaDetailResponseSchema,
  registeredSchemaIdentityListResponseSchema,
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

const identities = registeredSchemaIdentityListResponseSchema.parse({
  anchors: SCHEMA_FIXTURES.map(({ kind, anchor, environment }) => ({
    kind,
    path: anchor,
    environment,
  })),
  slots: [
    {
      kind: "slot",
      path: "/app/plugins/demo.notifications",
      environment: "default",
      accepts: "object",
    },
    {
      kind: "slot",
      path: "/app/plugins/demo.empty",
      environment: "default",
      accepts: "object",
    },
  ],
});

const details = SCHEMA_FIXTURES.map((fixture) =>
  registeredSchemaDetailResponseSchema.parse({
    kind: fixture.kind,
    path: fixture.anchor,
    environment: fixture.environment,
    schema: fixture.schema,
    metadata:
      fixture.kind === "service"
        ? {
            serviceId: "app",
            servicePath: "/app",
            environment: "default",
            providerId: "app",
            owner: { name: "Demo seed", contact: "offline@example.invalid" },
          }
        : {
            serviceId: "app",
            servicePath: "/app",
            environment: "default",
            providerId: "demo.notifications",
            canonicalSlotPath: fixture.anchor,
            fragmentPath: fixture.anchor,
            owner: { name: "Demo seed", contact: "offline@example.invalid" },
          },
  }),
);

export function seededSchemaIdentities() {
  return structuredClone(identities);
}

export function seededSchemaDetail(
  path: string,
  environment: string,
): RegisteredSchemaDetailResponse {
  const request = registeredSchemaDetailRequestSchema.parse({
    anchorPath: path,
    environment,
  });
  const detail = details.find(
    (entry) =>
      entry.path === request.anchorPath &&
      entry.environment === request.environment,
  );
  if (!detail)
    throw createWeaverError(
      "NOT_FOUND",
      `NOT_FOUND: schema anchor ${path} in ${environment} (404)`,
    );
  return structuredClone(detail);
}
