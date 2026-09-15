import {
  type ConfigurationPropertySchema,
  createWeaverError,
  type FragmentSchemaRegistrationRequest,
  fragmentSchemaRegistrationRequestSchema,
  type ObjectConfigurationPropertySchema,
  type ServiceSchemaRegistrationRequest,
  serviceSchemaRegistrationRequestSchema,
} from "@weaver-conf/config-types";
import { getSafeSchemaRegex } from "./regex-cache";
import { validateConfigurationDefaults } from "./schema-default-validation";

/** Compiles declarations, not data: absent containers are never materialized here. */
export function composeRegisteredServiceSchema(
  service: ServiceSchemaRegistrationRequest,
  fragments: readonly FragmentSchemaRegistrationRequest[],
): ObjectConfigurationPropertySchema {
  const parsed = serviceSchemaRegistrationRequestSchema.parse(service);
  const children = fragments.map((fragment) =>
    fragmentSchemaRegistrationRequestSchema.parse(fragment),
  );
  assertFragmentMembership(parsed, children);
  let schema = parsed.schema;
  for (const slot of parsed.fragmentSlots) {
    const members = children.filter(
      (child) => child.slotPath === slot.slotPath,
    );
    schema = composeSlot(schema, slot.slotPath.slice(1).split("/"), members);
  }
  const defaults = validateConfigurationDefaults(schema);
  if (!defaults.valid)
    fail(
      `Composed schema has invalid defaults: ${defaults.errors.map((error) => error.message).join("; ")}`,
    );
  return schema;
}

function assertFragmentMembership(
  service: ServiceSchemaRegistrationRequest,
  fragments: readonly FragmentSchemaRegistrationRequest[],
): void {
  const slots = service.fragmentSlots.map((slot) => slot.slotPath);
  if (new Set(slots).size !== slots.length) fail("Duplicate fragment slot");
  for (const slot of slots) {
    if (slots.some((other) => other !== slot && slot.startsWith(`${other}/`)))
      fail("Fragment slots must not overlap");
  }
  const seen = new Set<string>();
  for (const fragment of fragments) {
    if (
      fragment.serviceId !== service.serviceId ||
      fragment.environment !== service.environment ||
      !slots.includes(fragment.slotPath)
    ) {
      fail(
        `Fragment ${fragment.providerId} does not belong to a declared service slot`,
      );
    }
    const key = `${fragment.slotPath}/${fragment.providerId}`;
    if (seen.has(key)) fail(`Duplicate fragment ${key}`);
    seen.add(key);
  }
}

function composeSlot(
  parent: ObjectConfigurationPropertySchema,
  segments: readonly string[],
  fragments: readonly FragmentSchemaRegistrationRequest[],
): ObjectConfigurationPropertySchema {
  const [key, ...rest] = segments;
  if (key === undefined) return closeSlot(parent, fragments);
  assertNoPatternOverlap(parent, key);
  const properties = parent.properties ?? {};
  const existing = Object.hasOwn(properties, key) ? properties[key] : undefined;
  const fallback =
    typeof parent.additionalProperties === "object"
      ? parent.additionalProperties
      : undefined;
  const child = requireObjectContainer(
    existing ?? fallback ?? { type: "object" },
    key,
  );
  return {
    ...parent,
    properties: { ...properties, [key]: composeSlot(child, rest, fragments) },
  };
}

function requireObjectContainer(
  schema: ConfigurationPropertySchema,
  key: string,
): ObjectConfigurationPropertySchema {
  if (schema.type !== "object")
    fail(
      `Slot path ${key} must structurally fit an object-only parent container`,
    );
  return { ...schema, type: "object" };
}

function closeSlot(
  slot: ObjectConfigurationPropertySchema,
  fragments: readonly FragmentSchemaRegistrationRequest[],
): ObjectConfigurationPropertySchema {
  // Fragment definitions have one owner; overlapping child contracts are not silently discarded.
  if (
    Object.keys(slot.properties ?? {}).length ||
    Object.keys(slot.patternProperties ?? {}).length ||
    typeof slot.additionalProperties === "object"
  ) {
    fail(
      "Slot child schemas must be registered as fragments, not defined by parent properties/patternProperties/additionalProperties",
    );
  }
  const properties = Object.fromEntries(
    fragments.map((fragment) => [fragment.providerId, fragment.schema]),
  );
  for (const required of slot.required ?? []) {
    if (!Object.hasOwn(properties, required))
      fail(`Slot requires unregistered fragment ${required}`);
  }
  return { ...slot, properties, additionalProperties: false };
}

function assertNoPatternOverlap(
  parent: ConfigurationPropertySchema,
  key: string,
): void {
  for (const pattern of Object.keys(parent.patternProperties ?? {})) {
    if (getSafeSchemaRegex(pattern).test(key))
      fail(
        `Slot path ${key} overlaps parent patternProperties; declare its object container explicitly`,
      );
  }
}

function fail(message: string): never {
  throw createWeaverError("VALIDATION_ERROR", message);
}
