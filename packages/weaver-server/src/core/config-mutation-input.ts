import {
  createWeaverError,
  freezeBuiltinData,
} from "@weaver-conf/config-types";
import type { SchemaWriteContext, WriteContext } from "./config-service-types";

/** Detach before awaiting; validation, persistence and publication consume this owned snapshot. */
export function snapshotMutationInput<T>(value: T): T {
  try {
    return freezeBuiltinData(structuredClone(value));
  } catch {
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Mutation input cannot be detached",
    );
  }
}

export function snapshotWriteContext(
  options?: WriteContext,
): WriteContext | undefined {
  return options === undefined ? undefined : snapshotMutationInput(options);
}

/** Executable registry methods are captured, while serialized context and returned anchors detach. */
export function snapshotSchemaWriteContext(
  options: SchemaWriteContext,
): SchemaWriteContext {
  const { schemaRegistry, ...context } = options;
  const resolveAnchor = schemaRegistry.resolveAnchor.bind(schemaRegistry);
  return Object.freeze({
    ...snapshotMutationInput(context),
    schemaRegistry: Object.freeze({
      ...schemaRegistry,
      resolveAnchor: async (path: string, environment: string) =>
        snapshotMutationInput(await resolveAnchor(path, environment)),
    }),
  });
}
