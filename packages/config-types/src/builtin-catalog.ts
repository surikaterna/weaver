import type { z } from "zod";
import {
  type BuiltinSchemaView,
  createBuiltinSchemaView,
} from "./builtin-schema-view";
import {
  internalCatalogBindingSchema,
  internalCatalogSchema,
  internalFormatSchema,
  internalRegistrationRecordSchema,
} from "./internal-config";
import {
  internalInfrastructureGenerationSchema,
  internalInfrastructureSchema,
  internalLayoutSchema,
} from "./internal-infrastructure";
import {
  internalConfigurationSchema,
  internalScopeInventorySchema,
} from "./internal-state";
import { internalUpgradePlanSchema } from "./internal-upgrade-plan";
import { internalUpgradePlanRequestSchema } from "./internal-upgrade-planning";
import {
  INTERNAL_RECOVERY_MAX_BYTES,
  INTERNAL_RECOVERY_MAX_STEPS,
  internalRecoveryEnvelopeSchema,
  internalUpgradesSchema,
} from "./internal-upgrades";
import type { ObjectConfigurationPropertySchema } from "./property-schema";
import { registeredConfigurationSchemaSchema } from "./schemas-registration-grammar";
import {
  maintenanceStatusSchema,
  upgradeApplyRequestSchema,
  upgradeExecutionResultSchema,
  upgradeRecoveryRequestSchema,
} from "./upgrade-execution";

export const BUILTIN_CATALOG_DIGEST =
  "92a3e76ed2da66389f4a95d240feb91e3cec53a804ed5b0624efaa1634c0d029";
export const BUILTIN_CATALOG_REFERENCE = Object.freeze({
  id: "weaver.internal",
  version: 10,
  digest: BUILTIN_CATALOG_DIGEST,
});
export const SUPPORTED_SOURCE_BUILTIN_CATALOGS = Object.freeze([
  BUILTIN_CATALOG_REFERENCE,
  Object.freeze({
    id: "weaver.internal",
    version: 9,
    digest: "4ca506e53ca13c208678a2f38775ca40bcc9ca85de6636c8420b4afdb14e96ef",
  }),
  Object.freeze({
    id: "weaver.internal",
    version: 8,
    digest: "688ebcfcded43f629324ed7beffe0475162177063a7f91e1f0834a3f269d5b5d",
  }),
  Object.freeze({
    id: "weaver.internal",
    version: 7,
    digest: "a9a8de952998de66415641d87f6e81ceee64e4e4e9c6d07af52c01df64ddafbd",
  }),
]);

/** Executable code boundary, never deserialized or supplied by the public registry. */
export interface BuiltinCodeContract<T> {
  readonly path: string;
  readonly schema: BuiltinSchemaView<T>;
  /** Default annotations only; the strict Zod contract always authorizes the complete value. */
  readonly defaults: ObjectConfigurationPropertySchema;
}

const emptyDefaults: ObjectConfigurationPropertySchema = {
  type: "object",
  additionalProperties: true,
};
const formatDefaults: ObjectConfigurationPropertySchema = {
  ...emptyDefaults,
  properties: {
    initialization: {
      type: "string",
      enum: ["uninitialized", "initializing", "initialized"],
      default: "uninitialized",
    },
  },
};
const generationDefaults: ObjectConfigurationPropertySchema = {
  ...emptyDefaults,
  properties: {
    server: {
      ...emptyDefaults,
      properties: {
        port: { type: "integer", minimum: 1, maximum: 65535, default: 3399 },
        auth: {
          ...emptyDefaults,
          properties: {
            adminRoles: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
              default: ["admin"],
            },
          },
        },
      },
    },
  },
};
const infrastructureDefaults: ObjectConfigurationPropertySchema = {
  ...emptyDefaults,
  properties: {
    generations: { type: "object", additionalProperties: generationDefaults },
  },
};

function contract<T>(
  path: string,
  schema: z.ZodType<T>,
  defaults = emptyDefaults,
): BuiltinCodeContract<T> {
  return Object.freeze({
    path,
    schema: createBuiltinSchemaView(schema),
    defaults: freezeBuiltinData(structuredClone(defaults)),
  });
}

function createBuiltinCatalogSource() {
  return Object.freeze({
    id: BUILTIN_CATALOG_REFERENCE.id,
    version: BUILTIN_CATALOG_REFERENCE.version,
    contracts: Object.freeze({
      ...compilerContracts(),
      configuration: contract("/_weaver", internalConfigurationSchema, {
        ...emptyDefaults,
        properties: {
          format: formatDefaults,
          infrastructure: infrastructureDefaults,
        },
      }),
      format: contract("/_weaver/format", internalFormatSchema, formatDefaults),
      catalog: contract("/_weaver/catalog", internalCatalogSchema),
      registration: contract(
        "/_weaver/catalog/registrations/{recordId}",
        internalRegistrationRecordSchema,
      ),
      infrastructure: contract(
        "/_weaver/infrastructure",
        internalInfrastructureSchema,
        infrastructureDefaults,
      ),
      generation: contract(
        "/_weaver/infrastructure/generations/{generationId}",
        internalInfrastructureGenerationSchema,
        generationDefaults,
      ),
      scopeInventory: contract(
        "/_weaver/scopeInventory",
        internalScopeInventorySchema,
      ),
      upgrades: contract("/_weaver/upgrades", internalUpgradesSchema),
      plan: contract(
        "/_weaver/upgrades/plans/{planId}",
        internalUpgradePlanSchema,
      ),
      planRequest: contract(
        "api:upgrade-plan-request",
        internalUpgradePlanRequestSchema,
      ),
      recovery: contract(
        "/_weaver/upgrades/journal/{runId}",
        internalRecoveryEnvelopeSchema,
      ),
      upgradeApply: contract("api:upgrade-apply", upgradeApplyRequestSchema),
      upgradeRecovery: contract(
        "api:upgrade-recovery",
        upgradeRecoveryRequestSchema,
      ),
      upgradeResult: contract(
        "api:upgrade-result",
        upgradeExecutionResultSchema,
      ),
      maintenanceStatus: contract(
        "api:maintenance-status",
        maintenanceStatusSchema,
      ),
    }),
  });
}

function compilerContracts() {
  return {
    binding: contract("seed:store-binding", internalCatalogBindingSchema),
    defaultAnnotations: contract(
      "code:default-annotations",
      registeredConfigurationSchemaSchema,
    ),
    layout: contract(
      "/_weaver/infrastructure/generations/{generationId}/layout",
      internalLayoutSchema,
    ),
  };
}

const trustedSource = createBuiltinCatalogSource();

export function getBuiltinCatalogSource() {
  return trustedSource;
}

/** Schema and semantic version manifest; changing code refinements requires a catalog version/digest update. */
export function builtinCatalogManifest() {
  const source = getBuiltinCatalogSource();
  return {
    id: source.id,
    version: source.version,
    recoveryMaxBytes: INTERNAL_RECOVERY_MAX_BYTES,
    recoveryMaxSteps: INTERNAL_RECOVERY_MAX_STEPS,
    contracts: Object.fromEntries(
      Object.entries(source.contracts).map(([name, value]) => [
        name,
        {
          path: value.path,
          defaults: value.defaults,
          schema: value.schema.jsonSchema,
        },
      ]),
    ),
  };
}

export function freezeBuiltinData<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeBuiltinData(child);
    Object.freeze(value);
  }
  return value;
}
