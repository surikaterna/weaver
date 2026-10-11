import {
  inspectResolvedPath,
  parseCanonicalConfigPath,
  validateEffectiveConfiguration,
} from "@weaver-conf/config-engine";
import { registeredMutationFootprint } from "@weaver-conf/config-registry";
import {
  type ConfigurationValidationResponse,
  configurationValidationResponseSchema,
  createWeaverError,
  type SchemaValidationResult,
} from "@weaver-conf/config-types";
import type { IdentitySnapshot } from "../identity-snapshots";
import type { RootState } from "../root-state";
import { evidencePath } from "./authorization-requests";
import { forbidden } from "./capability-registry";

type Query = (path: string, operation: "read" | "inspect") => IdentitySnapshot;

/** Validate the issued raw snapshot, never the lossy public projection. */
export function validateIdentity(
  state: RootState,
  query: Query,
  path: string,
  viewNamespace?: string,
): ConfigurationValidationResponse {
  const snapshot = query(path, "inspect");
  const parsed = parseCanonicalConfigPath(path);
  const anchor = state.factory.registry.getRegisteredSchema(
    parsed.path,
    snapshot.identity.environment,
  );
  if (!anchor || anchor.path !== parsed.path)
    throw createWeaverError(
      "SCHEMA_NOT_REGISTERED",
      "An exact registered anchor is required",
    );
  const value = inspectResolvedPath(
    snapshot.raw,
    parsed.segments,
  ).effectiveValue;
  const footprint = registeredMutationFootprint(
    anchor.schema,
    [],
    value,
    value,
  );
  authorizeFootprint(
    footprint,
    snapshot,
    parsed.segments,
    query,
    viewNamespace,
  );
  const validation = validateEffectiveConfiguration(anchor.schema, value, {
    path: parsed.segments,
  });
  return configurationValidationResponseSchema.parse({
    identity: snapshot.identity,
    revision: snapshot.revision,
    path: parsed.path,
    validation: publicValidation(validation),
  });
}

function authorizeFootprint(
  footprint: ReturnType<typeof registeredMutationFootprint>,
  snapshot: IdentitySnapshot,
  root: readonly string[],
  query: Query,
  viewNamespace?: string,
): void {
  for (const item of footprint) {
    const segments = [...root, ...item.path];
    const storage = segments.indexOf("instances");
    if (
      storage >= 0 &&
      inspectResolvedPath(snapshot.raw, segments.slice(0, storage + 1))
        .effectiveValue === undefined
    )
      continue;
    const target = evidencePath(segments);
    if (
      viewNamespace &&
      (target === `${viewNamespace}/instances` ||
        target.startsWith(`${viewNamespace}/instances/`))
    )
      continue;
    const evidence = item.after;
    if (!evidence.declared || evidence.reference || evidence.forbidden)
      forbidden();
    query(target, "read");
  }
}

function publicValidation(
  result: SchemaValidationResult,
): SchemaValidationResult {
  return {
    valid: result.valid,
    // Validator diagnostics can contain enum literals and schema internals.
    errors: result.errors.map(({ code, path, segments }) => ({
      code,
      path,
      segments,
      message: "Configuration does not satisfy the registered schema",
    })),
  };
}
