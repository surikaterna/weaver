import {
  buildUpgradePlan,
  compileInternalRegistrations,
} from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalUpgradePlanRequest,
  type InternalUpgradePlanResponse,
  internalCatalogSchema,
  internalUpgradePlannerInputSchema,
  internalUpgradePlanRequestSchema,
  internalUpgradePlanResponseSchema,
  sha256Hex,
} from "@weaver-conf/config-types";
import type { WeaverConfigService } from "./config-service-types";
import { collectUpgradePlanningSnapshot } from "./upgrade-planning-snapshot";

export async function planRuntimeUpgrade(
  service: WeaverConfigService,
  requestInput: InternalUpgradePlanRequest,
): Promise<InternalUpgradePlanResponse> {
  const request = internalUpgradePlanRequestSchema.parse(
    structuredClone(requestInput),
  );
  const snapshot = await collectUpgradePlanningSnapshot(service);
  if (!snapshot.stable)
    return internalUpgradePlanResponseSchema.parse({
      version: 1,
      authorityRevision: snapshot.authorityRevision,
      result: {
        status: "blocked",
        refusals: [
          {
            code: "stale-binding",
            message: "Authority changed during snapshot",
          },
        ],
      },
    });
  const sourceCatalog = snapshot.configuration.catalog;
  const targetCatalog = internalCatalogSchema.parse({
    registrations: request.target.registrations,
  });
  const sourceSchemas = compileInternalRegistrations(sourceCatalog);
  const targetSchemas = compileInternalRegistrations(targetCatalog);
  const generationId = snapshot.configuration.infrastructure.activeGeneration;
  const infrastructure =
    snapshot.configuration.infrastructure.generations[generationId];
  if (!infrastructure)
    throw createWeaverError(
      "CONFIG_NOT_READY",
      "Active infrastructure generation is missing",
    );
  const input = internalUpgradePlannerInputSchema.parse({
    version: 1,
    request,
    authorityRevision: snapshot.authorityRevision,
    sourceCatalog,
    sourceCatalogDigest: digest(sourceCatalog),
    targetCatalog,
    targetCatalogDigest: digest(targetCatalog),
    schemas: schemaBindings(sourceSchemas, targetSchemas),
    inventory: snapshot.configuration.scopeInventory,
    infrastructureGenerationId: generationId,
    infrastructure,
    providers: snapshot.providers,
  });
  return internalUpgradePlanResponseSchema.parse({
    version: 1,
    authorityRevision: snapshot.authorityRevision,
    result: buildUpgradePlan(input),
  });
}

function schemaBindings(
  source: ReadonlyMap<
    string,
    import("@weaver-conf/config-types").ObjectConfigurationPropertySchema
  >,
  target: ReadonlyMap<
    string,
    import("@weaver-conf/config-types").ObjectConfigurationPropertySchema
  >,
) {
  const keys = new Set([...source.keys(), ...target.keys()]);
  return [...keys].sort().map((key) => ({
    path: key.slice(0, key.lastIndexOf(":")),
    environment: key.slice(key.lastIndexOf(":") + 1),
    ...(source.get(key) ? { source: source.get(key) } : {}),
    ...(target.get(key) ? { target: target.get(key) } : {}),
  }));
}

function digest(value: unknown): string {
  return sha256Hex(canonicalInternalJson(value));
}
