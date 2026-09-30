import { createSchemaRegistry } from "../../src/core/schema-registry.ts";

export async function registerTestService(configService, serviceId, environment, properties, options = {}) {
  const registry = createSchemaRegistry({ configService });
  await registerTestSchema(registry, serviceId, environment, properties, options);
  return registry;
}

export async function registerTestSchema(registry, serviceId, environment, properties, options = {}) {
  const result = await registry.register({
    serviceId,
    environment,
    owner: { name: serviceId, contact: `${serviceId}@example.com` },
    schema: {
      type: "object",
      properties,
      ...(options.patternProperties ? { patternProperties: options.patternProperties } : {}),
      additionalProperties: options.additionalProperties ?? false,
    },
    fragmentSlots: options.fragmentSlots ?? [],
  });
  if (!result.success) throw new Error(`Failed to register ${serviceId}: ${result.error?.message}`);
}
