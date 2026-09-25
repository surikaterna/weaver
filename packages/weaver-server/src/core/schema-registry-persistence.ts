import { assertPublicConfigPath } from "@weaver-conf/config-engine";
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
  const metadataPath =
    entry.kind === "service"
      ? entry.metadata.servicePath
      : entry.metadata.fragmentPath;
  if (metadataPath !== path) {
    throw new Error(`Persisted schema "${path}" metadata path mismatch`);
  }
}

function validatePersistedSlot(
  environment: string,
  path: string,
  slot: z.infer<typeof fragmentSlotRegistrationMetadataSchema>,
): void {
  assertPublicConfigPath(path);
  if (slot.environment !== environment || slot.canonicalSlotPath !== path) {
    throw new Error(`Persisted slot "${path}" metadata mismatch`);
  }
}
