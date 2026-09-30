import {
  detectBreakingChanges,
  schemasEqual,
} from "@weaver-conf/config-engine";
import type {
  ConfigurationPropertySchema,
  FragmentSlotRegistrationMetadata,
  SchemaRegistrationMetadata,
  SchemaRegistrationRequest,
} from "@weaver-conf/config-types";
import {
  type ParsedSuccessfulRegistration,
  parseRegistrationRequest,
  validationFailure,
} from "./registration-parser";
import type {
  SchemaRegistrationContext,
  SchemaRegistrationResult,
} from "./registry-contracts";
import {
  type RegistrationEvaluation,
  type RegistryState,
  type SchemaEntry,
  schemaKey,
} from "./registry-state";

export function evaluateRegistration(
  state: RegistryState,
  request: SchemaRegistrationRequest,
  _context?: SchemaRegistrationContext,
): RegistrationEvaluation {
  const parsed = parseRegistrationRequest(request);
  if (!parsed.success) return { result: parsed.result };
  const key = schemaKey(parsed.targetPath, parsed.environment);
  if (parsed.kind === "fragment")
    return evaluateFragmentRegistration(state, parsed, key);
  const staleSlots = findRemovedSlots(state, parsed);
  const occupiedSlot = staleSlots.find((slot) =>
    hasRegisteredFragment(state, slot),
  );
  if (occupiedSlot) {
    return {
      result: validationFailure(
        `Cannot remove fragment slot "${occupiedSlot.canonicalSlotPath}" while fragments are registered`,
      ),
    };
  }
  const existing = state.schemas.get(key);
  const result = existing
    ? evaluateExistingRegistration(existing, parsed.schema, parsed.metadata)
    : newSchemaResult(parsed.metadata);
  return {
    result,
    entry: schemaEntry(parsed),
    key,
    slots: parsed.slots,
    slotKeysToRemove: staleSlots.map((slot) =>
      schemaKey(slot.canonicalSlotPath, slot.environment),
    ),
  };
}

function findRemovedSlots(
  state: RegistryState,
  parsed: ParsedSuccessfulRegistration,
): FragmentSlotRegistrationMetadata[] {
  const nextSlotPaths = new Set(
    parsed.slots.map((slot) => slot.canonicalSlotPath),
  );
  return [...state.slots.values()].filter(
    (slot) =>
      slot.servicePath === parsed.targetPath &&
      slot.environment === parsed.environment &&
      !nextSlotPaths.has(slot.canonicalSlotPath),
  );
}

function hasRegisteredFragment(
  state: RegistryState,
  slot: FragmentSlotRegistrationMetadata,
): boolean {
  const fragmentRoot = `${slot.canonicalSlotPath}/`;
  for (const entry of state.schemas.values()) {
    if (entry.kind !== "fragment") continue;
    if (entry.environment !== slot.environment) continue;
    if (entry.path.startsWith(fragmentRoot)) return true;
  }
  return false;
}

function evaluateFragmentRegistration(
  state: RegistryState,
  parsed: ParsedSuccessfulRegistration,
  key: string,
): RegistrationEvaluation {
  const slotPath = parsed.metadata.canonicalSlotPath;
  const slot = slotPath
    ? state.slots.get(schemaKey(slotPath, parsed.environment))
    : undefined;
  if (
    !slot ||
    slot.canonicalSlotPath !== slotPath ||
    slot.environment !== parsed.environment ||
    slot.serviceId !== parsed.metadata.serviceId ||
    slot.servicePath !== parsed.metadata.servicePath
  ) {
    return {
      result: validationFailure(`Unknown fragment slot "${slotPath ?? ""}"`),
    };
  }
  if (state.schemas.has(key)) {
    return {
      result: validationFailure(
        `Duplicate fragment registration for "${parsed.targetPath}"`,
      ),
    };
  }
  return {
    result: newSchemaResult(parsed.metadata),
    entry: schemaEntry(parsed),
    key,
  };
}

function schemaEntry(parsed: ParsedSuccessfulRegistration): SchemaEntry {
  return {
    kind: parsed.kind,
    path: parsed.targetPath,
    schema: parsed.schema,
    environment: parsed.environment,
    metadata: parsed.metadata,
  };
}

function newSchemaResult(
  metadata: SchemaRegistrationMetadata,
): SchemaRegistrationResult {
  return {
    success: true,
    isNewSchema: true,
    hasBreakingChanges: false,
    metadata,
  };
}

function evaluateExistingRegistration(
  existing: SchemaEntry,
  schema: ConfigurationPropertySchema,
  metadata: SchemaRegistrationMetadata,
): SchemaRegistrationResult {
  if (schemasEqual(existing.schema, schema)) {
    return {
      success: true,
      isNewSchema: false,
      hasBreakingChanges: false,
      metadata,
    };
  }
  const breakingChanges = detectBreakingChanges(existing.schema, schema);
  return {
    success: true,
    isNewSchema: false,
    hasBreakingChanges: breakingChanges.length > 0,
    metadata,
    ...(breakingChanges.length > 0
      ? { breakingChanges: breakingChanges.map((c) => c.message) }
      : {}),
  };
}
