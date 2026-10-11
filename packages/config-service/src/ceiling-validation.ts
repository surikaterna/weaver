import {
  type RegistryProjectionReader,
  validateRegisteredCeilingNames,
} from "@weaver-conf/config-registry";
import { createWeaverError } from "@weaver-conf/config-types";

/** Includes inactive environments and fragment anchors before any storage effect. */
export function validateRegistryCeilings(
  registry: RegistryProjectionReader,
  names: readonly string[],
): void {
  for (const identity of registry.listRegisteredSchemaIdentities().anchors) {
    const anchor = registry.resolveAnchor(identity.path, identity.environment);
    if (!anchor)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Missing registered ceiling owner",
      );
    validateRegisteredCeilingNames(anchor.schema, names);
  }
}
