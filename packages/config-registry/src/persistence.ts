import { createWeaverError } from "@weaver-conf/config-types";
import { snapshotPlainData } from "./plain-data-graph";
import {
  parsePersistedRegistry as parse,
  serializeRegistry as serialize,
} from "./registry-persistence";
import type { RegistryState } from "./registry-state";
import {
  decodeSchemaGraph as decode,
  encodeSchemaGraph as encode,
} from "./schema-graph-codec";
import { ownValue } from "./structural-witness-own-data";

export {
  type SerializedSchemaRegistry,
  serializedSchemaRegistrySchema,
} from "./registry-persistence";
export type { RegistryState } from "./registry-state";
export { registryStateSchema } from "./registry-state";
export {
  type PersistedSchemaGraph,
  persistedSchemaGraphSchema,
  schemaGraphEncoding,
} from "./schema-graph-codec";

function boundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid registry persistence data",
    );
  }
}

export function parsePersistedRegistry(input: unknown): RegistryState {
  return boundary(() => {
    const captured = snapshotPlainData(input);
    if (!captured.success) throw new Error();
    return parse(captured.value);
  });
}

export function serializeRegistry(
  state: RegistryState,
): ReturnType<typeof serialize> {
  return boundary(() => serialize(state));
}

export function encodeSchemaGraph(input: Parameters<typeof encode>[0]) {
  return boundary(() => {
    admitGraphDescriptors(input);
    return encode(input);
  });
}

export function decodeSchemaGraph(input: unknown) {
  return boundary(() => {
    admitGraphDescriptors(input);
    return decode(input);
  });
}

// Admission only: the codec/native schemas own structural validity. Unlike the
// plain registry envelope, unknown-valued annotations may be cyclic or opaque.
function admitGraphDescriptors(input: unknown): void {
  const pending: unknown[] = [input];
  const seen = new WeakSet();
  while (pending.length) {
    const value = pending.pop();
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      continue;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const key of Reflect.ownKeys(value))
      pending.push(ownValue(value, key));
  }
}
