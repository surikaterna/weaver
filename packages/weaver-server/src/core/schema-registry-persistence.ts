import {
  assertPublicConfigPath,
  deriveCanonicalSlotPath,
  deriveFragmentPath,
  deriveServicePath,
} from "@weaver-conf/config-engine";
import {
  fragmentSlotRegistrationMetadataSchema,
  objectConfigurationPropertySchemaSchema,
  registrationEnvironmentSchema,
  schemaRegistrationMetadataSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";
import {
  decodeSchemaGraph,
  encodeSchemaGraph,
  type PersistedSchemaGraph,
} from "./schema-registry-schema-codec";
import type { RegistryState, SchemaEntry } from "./schema-registry-state";
import { createEmptyState, schemaKey } from "./schema-registry-state";

const persistedSchemaEntrySchema = z.strictObject({
  kind: z.enum(["service", "fragment"]),
  schema: z.unknown(),
  metadata: schemaRegistrationMetadataSchema,
});

const persistedEnvironmentRegistrySchema = z.strictObject({
  schemas: z.record(z.string(), persistedSchemaEntrySchema),
  slots: z.record(z.string(), fragmentSlotRegistrationMetadataSchema),
});

const persistedSchemaRegistrySchema = z.strictObject({
  environments: z.record(
    registrationEnvironmentSchema,
    persistedEnvironmentRegistrySchema,
  ),
});

type PersistedSchemaEntry = z.infer<typeof persistedSchemaEntrySchema>;
interface SerializedSchemaEntry extends Omit<PersistedSchemaEntry, "schema"> {
  readonly schema: PersistedSchemaGraph;
}
interface SerializedSchemaRegistry {
  readonly environments: Record<
    string,
    {
      readonly schemas: Record<string, SerializedSchemaEntry>;
      readonly slots: Record<
        string,
        z.infer<typeof fragmentSlotRegistrationMetadataSchema>
      >;
    }
  >;
}
type MutablePersistedEnvironment = {
  readonly schemas: Map<string, SerializedSchemaEntry>;
  readonly slots: Map<
    string,
    z.infer<typeof fragmentSlotRegistrationMetadataSchema>
  >;
};

export function serializeRegistry(
  state: RegistryState,
): SerializedSchemaRegistry {
  const environments = new Map<string, MutablePersistedEnvironment>();
  for (const entry of state.schemas.values()) {
    const env = getPersistedEnvironment(environments, entry.environment);
    env.schemas.set(entry.path, {
      kind: entry.kind,
      schema: encodeSchemaGraph(entry.schema),
      metadata: entry.metadata,
    });
  }
  for (const slot of state.slots.values()) {
    const env = getPersistedEnvironment(environments, slot.environment);
    env.slots.set(slot.canonicalSlotPath, slot);
  }
  return { environments: serializeEnvironments(environments) };
}

export function parsePersistedRegistry(raw: unknown): RegistryState {
  const state = createEmptyState();
  if (raw === undefined || raw === null) return state;
  if (!isRecord(raw)) {
    throw new Error("Persisted schema registry must be an object");
  }
  if (!isRecord(raw.environments)) {
    throw new Error(
      "Persisted schema registry must include environments object",
    );
  }
  validateRawEnvironmentKeys(raw.environments);
  const persisted = persistedSchemaRegistrySchema.parse(raw);
  for (const [environment, env] of Object.entries(persisted.environments)) {
    for (const [path, entry] of Object.entries(env.schemas)) {
      validatePersistedEntry(environment, path, entry);
      state.schemas.set(
        schemaKey(path, environment),
        toSchemaEntry(entry, path, environment),
      );
    }
    for (const [path, slot] of Object.entries(env.slots)) {
      validatePersistedSlot(environment, path, slot);
      state.slots.set(schemaKey(path, environment), slot);
    }
  }
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRawEnvironmentKeys(
  environments: Record<string, unknown>,
): void {
  for (const environment of Object.keys(environments)) {
    registrationEnvironmentSchema.parse(environment);
  }
}

function getPersistedEnvironment(
  environments: Map<string, MutablePersistedEnvironment>,
  environment: string,
): MutablePersistedEnvironment {
  const existing = environments.get(environment);
  if (existing !== undefined) return existing;
  const created = { schemas: new Map(), slots: new Map() };
  environments.set(environment, created);
  return created;
}

function serializeEnvironments(
  environments: ReadonlyMap<string, MutablePersistedEnvironment>,
): SerializedSchemaRegistry["environments"] {
  return Object.fromEntries(
    [...environments].map(([environment, registry]) => [
      environment,
      {
        schemas: Object.fromEntries(registry.schemas),
        slots: Object.fromEntries(registry.slots),
      },
    ]),
  );
}

function toSchemaEntry(
  entry: PersistedSchemaEntry,
  path: string,
  environment: string,
): SchemaEntry {
  return {
    kind: entry.kind,
    schema: parsePersistedSchema(entry.schema),
    metadata: entry.metadata,
    path,
    environment,
  };
}

function parsePersistedSchema(schema: unknown) {
  if (isRecord(schema) && Object.hasOwn(schema, "encoding")) {
    return decodeSchemaGraph(schema);
  }
  return objectConfigurationPropertySchemaSchema.parse(schema);
}

function validatePersistedEntry(
  environment: string,
  path: string,
  entry: PersistedSchemaEntry,
): void {
  assertPublicConfigPath(path);
  if (entry.metadata.environment !== environment) {
    throw new Error(`Persisted schema "${path}" environment mismatch`);
  }
  if (entry.kind === "service") validatePersistedService(path, entry);
  else validatePersistedFragment(path, entry);
}

function validatePersistedSlot(
  environment: string,
  path: string,
  slot: z.infer<typeof fragmentSlotRegistrationMetadataSchema>,
): void {
  assertPublicConfigPath(path);
  const service = deriveServicePath(slot.serviceId);
  const canonicalSlotPath = deriveCanonicalSlotPath(
    slot.serviceId,
    slot.slotPath,
  );
  assertMatchingPath(slot.servicePath, service.servicePath, "slot service");
  assertMatchingPath(
    slot.canonicalSlotPath,
    canonicalSlotPath,
    "slot canonical",
  );
  if (
    slot.environment !== environment ||
    slot.providerId !== slot.serviceId ||
    canonicalSlotPath !== path
  ) {
    throw new Error(`Persisted slot "${path}" metadata mismatch`);
  }
}

function validatePersistedService(
  path: string,
  entry: PersistedSchemaEntry,
): void {
  const metadata = entry.metadata;
  const service = deriveServicePath(metadata.serviceId);
  assertMatchingPath(metadata.servicePath, service.servicePath, "service");
  assertOptionalPublicPath(metadata.canonicalSlotPath);
  assertOptionalPublicPath(metadata.fragmentPath);
  if (
    metadata.providerId !== metadata.serviceId ||
    metadata.canonicalSlotPath !== undefined ||
    metadata.fragmentPath !== undefined ||
    service.servicePath !== path
  ) {
    throw new Error(`Persisted schema "${path}" metadata path mismatch`);
  }
}

function validatePersistedFragment(
  path: string,
  entry: PersistedSchemaEntry,
): void {
  const metadata = entry.metadata;
  const service = deriveServicePath(metadata.serviceId);
  assertMatchingPath(
    metadata.servicePath,
    service.servicePath,
    "fragment service",
  );
  const canonicalSlotPath = requireFragmentSlotPath(metadata.canonicalSlotPath);
  const slotPath = canonicalSlotPath.slice(service.servicePath.length);
  const fragment = deriveFragmentPath(
    metadata.serviceId,
    slotPath,
    metadata.providerId,
  );
  assertMatchingPath(
    canonicalSlotPath,
    fragment.canonicalSlotPath,
    "fragment slot",
  );
  assertMatchingPath(metadata.fragmentPath, fragment.fragmentPath, "fragment");
  if (fragment.fragmentPath !== path) {
    throw new Error(`Persisted schema "${path}" metadata path mismatch`);
  }
}

function requireFragmentSlotPath(path: string | undefined): string {
  if (path === undefined)
    throw new Error("Persisted fragment slot path missing");
  return assertPublicConfigPath(path);
}

function assertMatchingPath(
  actual: string | undefined,
  expected: string,
  field: string,
): void {
  if (actual === undefined || assertPublicConfigPath(actual) !== expected) {
    throw new Error(`Persisted ${field} path metadata mismatch`);
  }
}

function assertOptionalPublicPath(path: string | undefined): void {
  if (path !== undefined) assertPublicConfigPath(path);
}
