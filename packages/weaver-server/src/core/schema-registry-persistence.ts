import {
  assertPublicConfigPath,
  deriveCanonicalSlotPath,
  deriveFragmentPath,
  deriveServicePath,
} from "@weaver-conf/config-engine";
import {
  configurationPropertySchemaSchema,
  fragmentSlotRegistrationMetadataSchema,
  schemaRegistrationMetadataSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";
import type { RegistryState, SchemaEntry } from "./schema-registry-state";
import { createEmptyState, schemaKey } from "./schema-registry-state";

const persistedSchemaEntrySchema = z.strictObject({
  kind: z.enum(["service", "fragment"]),
  schema: configurationPropertySchemaSchema,
  metadata: schemaRegistrationMetadataSchema,
});

const persistedEnvironmentRegistrySchema = z.strictObject({
  schemas: z.record(z.string(), persistedSchemaEntrySchema),
  slots: z.record(z.string(), fragmentSlotRegistrationMetadataSchema),
});

const persistedSchemaRegistrySchema = z.strictObject({
  environments: z.record(z.string(), persistedEnvironmentRegistrySchema),
});

type PersistedSchemaEntry = z.infer<typeof persistedSchemaEntrySchema>;
type PersistedSchemaRegistry = z.infer<typeof persistedSchemaRegistrySchema>;

export function serializeRegistry(
  state: RegistryState,
): PersistedSchemaRegistry {
  const persisted: PersistedSchemaRegistry = { environments: {} };
  for (const entry of state.schemas.values()) {
    const env = getPersistedEnvironment(persisted, entry.environment);
    env.schemas[entry.path] = {
      kind: entry.kind,
      schema: entry.schema,
      metadata: entry.metadata,
    };
  }
  for (const slot of state.slots.values()) {
    const env = getPersistedEnvironment(persisted, slot.environment);
    env.slots[slot.canonicalSlotPath] = slot;
  }
  return persisted;
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

function getPersistedEnvironment(
  registry: PersistedSchemaRegistry,
  environment: string,
): PersistedSchemaRegistry["environments"][string] {
  registry.environments[environment] = registry.environments[environment] ?? {
    schemas: {},
    slots: {},
  };
  return registry.environments[environment];
}

function toSchemaEntry(
  entry: PersistedSchemaEntry,
  path: string,
  environment: string,
): SchemaEntry {
  return {
    kind: entry.kind,
    schema: entry.schema,
    metadata: entry.metadata,
    path,
    environment,
  };
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
