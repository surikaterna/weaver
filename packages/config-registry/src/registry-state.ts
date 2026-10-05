import type {
  FragmentSlotRegistrationMetadata,
  ObjectConfigurationPropertySchema,
  SchemaRegistrationMetadata,
} from "@weaver-conf/config-types";
import { fragmentSlotRegistrationMetadataSchema } from "@weaver-conf/config-types";
import { z } from "zod";
import type { SchemaRegistrationResult } from "./registry-contracts";
import { registeredSchemaAnchorSchema } from "./registry-contracts";

export interface SchemaEntry {
  readonly kind: "service" | "fragment";
  readonly path: string;
  readonly schema: ObjectConfigurationPropertySchema;
  readonly environment: string;
  readonly metadata: SchemaRegistrationMetadata;
}

export interface RegistryState {
  readonly schemas: Map<string, SchemaEntry>;
  readonly slots: Map<string, FragmentSlotRegistrationMetadata>;
}

export const schemaEntrySchema: z.ZodType<SchemaEntry> =
  registeredSchemaAnchorSchema;
export const registryStateSchema: z.ZodType<RegistryState> = z.strictObject({
  schemas: z.map(z.string(), schemaEntrySchema),
  slots: z.map(z.string(), fragmentSlotRegistrationMetadataSchema),
});

export interface RegistrationEvaluation {
  readonly result: SchemaRegistrationResult;
  readonly entry?: SchemaEntry | undefined;
  readonly key?: string | undefined;
  readonly slots?: ReadonlyArray<FragmentSlotRegistrationMetadata> | undefined;
  readonly slotKeysToRemove?: ReadonlyArray<string> | undefined;
}

export function schemaKey(path: string, environment: string): string {
  return JSON.stringify([path, environment]);
}

export function createEmptyState(): RegistryState {
  return { schemas: new Map(), slots: new Map() };
}

export function cloneState(state: RegistryState): RegistryState {
  return { schemas: new Map(state.schemas), slots: new Map(state.slots) };
}

export function applyEvaluation(
  state: RegistryState,
  evaluation: RegistrationEvaluation,
): void {
  if (evaluation.entry && evaluation.key)
    state.schemas.set(evaluation.key, evaluation.entry);
  for (const key of evaluation.slotKeysToRemove ?? []) state.slots.delete(key);
  for (const slot of evaluation.slots ?? []) {
    state.slots.set(schemaKey(slot.canonicalSlotPath, slot.environment), slot);
  }
}
