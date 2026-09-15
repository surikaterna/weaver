import { composeRegisteredServiceSchema } from "@weaver-conf/config-engine";
import {
  createWeaverError,
  type FragmentSchemaRegistrationRequest,
} from "@weaver-conf/config-types";
import type { RegistryState, SchemaEntry } from "./schema-registry-state";

export function composeRegistryEntries(state: RegistryState): SchemaEntry[] {
  const entries = [...state.schemas.values()];
  assertRegistryMembership(state, entries);
  return entries.map((entry) =>
    entry.kind === "service" ? composeService(state, entry, entries) : entry,
  );
}

function composeService(
  state: RegistryState,
  service: SchemaEntry,
  entries: readonly SchemaEntry[],
): SchemaEntry {
  const slots = [...state.slots.values()].filter(
    (slot) =>
      slot.servicePath === service.path &&
      slot.environment === service.environment,
  );
  const fragments = entries.filter(
    (entry) =>
      entry.kind === "fragment" &&
      entry.metadata.servicePath === service.path &&
      entry.environment === service.environment,
  );
  const schema = composeRegisteredServiceSchema(
    {
      serviceId: service.metadata.serviceId,
      environment: service.environment,
      owner: service.metadata.owner,
      schema: service.schema,
      fragmentSlots: slots.map((slot) => ({
        slotPath: slot.slotPath,
        accepts: slot.accepts,
      })),
    },
    fragments.map(fragmentRequest),
  );
  return { ...service, schema };
}

function fragmentRequest(
  entry: SchemaEntry,
): FragmentSchemaRegistrationRequest {
  const slot = entry.metadata.canonicalSlotPath;
  if (!slot)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Fragment has no declared slot",
    );
  return {
    serviceId: entry.metadata.serviceId,
    environment: entry.environment,
    owner: entry.metadata.owner,
    providerId: entry.metadata.providerId,
    slotPath: slot.slice(entry.metadata.servicePath.length),
    schema: entry.schema,
  };
}

function assertRegistryMembership(
  state: RegistryState,
  entries: readonly SchemaEntry[],
): void {
  const slots = [...state.slots.values()];
  for (const slot of slots) {
    if (
      !entries.some(
        (entry) =>
          entry.kind === "service" &&
          entry.path === slot.servicePath &&
          entry.environment === slot.environment,
      )
    ) {
      throw createWeaverError(
        "VALIDATION_ERROR",
        `Orphan fragment slot ${slot.canonicalSlotPath}`,
      );
    }
  }
  for (const entry of entries.filter((entry) => entry.kind === "fragment")) {
    if (
      !slots.some(
        (slot) =>
          slot.canonicalSlotPath === entry.metadata.canonicalSlotPath &&
          slot.environment === entry.environment,
      )
    ) {
      throw createWeaverError(
        "VALIDATION_ERROR",
        `Unregistered fragment slot for ${entry.path}`,
      );
    }
  }
}
