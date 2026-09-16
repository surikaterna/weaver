import { randomUUID } from "node:crypto";
import { deepEqual } from "@weaver-conf/config-engine";
import {
  canonicalInternalJson,
  createWeaverError,
  type InternalConfiguration,
  type InternalInfrastructureGeneration,
  type InternalRecoveryEnvelope,
  type InternalUpgradePlan,
  type SchemaRegistrationRequest,
  type ScopeInventory,
  WeaverErrorInstance,
  type WriteResult,
} from "@weaver-conf/config-types";
import {
  activateUpgradeControl,
  controlRecovery,
  recordActivationCompletion,
  repairControlStep,
} from "./config-maintenance-internal";
import {
  createPinnedWeaverConfigService,
  createWeaverConfigService,
} from "./config-service";
import {
  activateControlApplication,
  controlProjection,
  controlTransaction,
} from "./config-service-internal";
import type {
  WeaverConfigService,
  WeaverConfigServiceOptions,
} from "./config-service-types";
import {
  prepareInitialJournal,
  prepareJournalReplacement,
} from "./control-journal-lineage";
import {
  createSchemaRegistry,
  type SchemaRegistrationContext,
} from "./schema-registry";

/** Views share one service, coordinator, and already-owned provider handles. */
export async function createControlService(
  options: WeaverConfigServiceOptions,
) {
  const service = await createWeaverConfigService({
    ...options,
    serviceMode: "control",
  });
  return controlService(service);
}

export async function createPinnedControlService(
  options: WeaverConfigServiceOptions,
  pinnedRecovery: unknown,
) {
  const service = await createPinnedWeaverConfigService(
    { ...options, serviceMode: "control" },
    pinnedRecovery,
  );
  return controlService(service);
}

function controlService(service: WeaverConfigService) {
  const owner = randomUUID();
  return Object.freeze({
    owner,
    get revision() {
      return service.revision;
    },
    binding: Object.freeze({ ...controlProjection(service).binding }),
    configuration: service,
    ...bootstrapView(service),
    ...maintenanceView(service, owner),
    registerSchema: (
      request: SchemaRegistrationRequest,
      context?: SchemaRegistrationContext,
    ) =>
      createSchemaRegistry({ configService: service }).register(
        request,
        context,
      ),
    application: () => activateControlApplication(service),
    close: async () => {
      await service.close?.();
    },
  });
}

function bootstrapView(service: WeaverConfigService) {
  return {
    initialize: (
      configuration: InternalConfiguration,
      expectedRevision = service.revision,
    ) =>
      controlResult(() =>
        controlTransaction(service, "bootstrap", ({ write }) =>
          write("_weaver", configuration, { expectedRevision }),
        ),
      ),
    ...generationActivation(service),
    stageGeneration: (
      id: string,
      generation: InternalInfrastructureGeneration,
      expectedRevision: string,
    ) =>
      controlResult(() =>
        controlTransaction(service, "bootstrap", ({ write }) =>
          write(`_weaver.infrastructure.generations.${id}`, generation, {
            expectedRevision,
          }),
        ),
      ),
    ...inventoryInitialization(service),
    finalize: (expectedRevision: string) =>
      controlResult(() =>
        controlTransaction(service, "bootstrap", ({ write }) => {
          const state = controlProjection(service).prepared().configuration;
          return write(
            "_weaver.format",
            { ...state.format, initialization: "initialized" },
            { expectedRevision },
          );
        }),
      ),
  };
}

function generationActivation(service: WeaverConfigService) {
  return {
    selectDraftGeneration: (id: string, expectedRevision: string) =>
      controlResult(() =>
        controlTransaction(service, "bootstrap", ({ write }) => {
          if (
            controlProjection(service).prepared().configuration.format
              .initialization === "initialized"
          )
            throw createWeaverError(
              "FORBIDDEN",
              "Initialized infrastructure requires validated activation",
            );
          return write("_weaver.infrastructure.activeGeneration", id, {
            expectedRevision,
          });
        }),
      ),
    activateGeneration: (id: string, expectedRevision: string) =>
      controlResult(() =>
        controlTransaction(service, "bootstrap", ({ write }) => {
          const state = controlProjection(service).prepared().configuration;
          return write(
            "_weaver",
            {
              ...state,
              format: { ...state.format, initialization: "initialized" },
              infrastructure: { ...state.infrastructure, activeGeneration: id },
            },
            { expectedRevision },
          );
        }),
      ),
  };
}

function inventoryInitialization(service: WeaverConfigService) {
  return {
    initializeInventory: (
      inventory: ScopeInventory,
      expectedRevision: string,
    ) =>
      controlResult(() =>
        controlTransaction(service, "scope", async ({ write }) => {
          const state = controlProjection(service).prepared().configuration;
          if (expectedRevision !== service.revision)
            throw createWeaverError(
              "REVISION_CONFLICT",
              "Inventory initialization precondition changed",
            );
          if (
            state.format.initialization !== "initialized" &&
            deepEqual(state.scopeInventory, inventory)
          )
            return { success: true, revision: service.revision };
          if (
            state.format.initialization === "initialized" ||
            Object.keys(state.scopeInventory.contexts).length ||
            inventory.revision !== "0"
          )
            throw createWeaverError(
              "FORBIDDEN",
              "Inventory initialization is limited to the empty draft",
            );
          return write("_weaver.scopeInventory", inventory, {
            expectedRevision,
          });
        }),
      ),
  };
}

function maintenanceView(service: WeaverConfigService, owner: string) {
  return {
    storePlan: (plan: InternalUpgradePlan, expectedRevision: string) =>
      controlTransaction(service, "maintenance", ({ write }) =>
        write(`_weaver.upgrades.plans.${plan.id}`, plan, { expectedRevision }),
      ),
    replaceJournal: async (
      journal: InternalRecoveryEnvelope,
      expectedRevision: string,
      operationId?: string,
    ) => {
      const previous =
        controlProjection(service).prepared().configuration.upgrades.journal[
          journal.runId
        ];
      const explicitAdoption =
        previous &&
        previous.owner !== owner &&
        journal.adoption?.previousOwner === previous.owner &&
        journal.adoption.adoptedBy === owner;
      if (
        journal.owner !== owner ||
        (previous?.owner !== owner && !explicitAdoption)
      )
        throw createWeaverError("FORBIDDEN", "Journal owner mismatch");
      if (!previous)
        throw createWeaverError(
          "VALIDATION_ERROR",
          "Recovery journal is missing",
        );
      const prepared = await prepareJournalReplacement(
        service,
        previous,
        journal,
        operationId ?? randomUUID(),
      );
      return controlTransaction(service, "maintenance", ({ write }) =>
        write(`_weaver.upgrades.journal.${journal.runId}`, prepared, {
          expectedRevision,
          ...(prepared.control
            ? { operationId: prepared.control.operationId }
            : {}),
        }),
      );
    },
    prepareJournal: (journal: InternalRecoveryEnvelope) => {
      const previous =
        controlProjection(service).prepared().configuration.upgrades.journal[
          journal.runId
        ];
      if (!previous)
        throw createWeaverError(
          "VALIDATION_ERROR",
          "Recovery journal is missing",
        );
      return prepareJournalReplacement(
        service,
        previous,
        journal,
        randomUUID(),
      );
    },
    replacePreparedJournal: async (
      journal: InternalRecoveryEnvelope,
      expectedRevision: string,
    ) => {
      const previous =
        controlProjection(service).prepared().configuration.upgrades.journal[
          journal.runId
        ];
      const operationId = journal.control?.operationId;
      if (!previous || !operationId)
        throw createWeaverError(
          "VALIDATION_ERROR",
          "Prepared journal is incomplete",
        );
      const expected = await prepareJournalReplacement(
        service,
        previous,
        journal,
        operationId,
      );
      if (!deepEqual(expected, journal))
        throw createWeaverError(
          "VALIDATION_ERROR",
          "Prepared journal lineage differs",
        );
      return controlTransaction(service, "maintenance", ({ write }) =>
        write(`_weaver.upgrades.journal.${journal.runId}`, journal, {
          expectedRevision,
          ...{ operationId },
        }),
      );
    },
    activateUpgrade: (
      journal: InternalRecoveryEnvelope,
      plan: InternalUpgradePlan,
      expectedRevision: string,
    ) => {
      if (journal.owner !== owner)
        throw createWeaverError("FORBIDDEN", "Journal owner mismatch");
      return activateUpgradeControl(service, plan, journal, expectedRevision);
    },
    completeActivation: (journal: InternalRecoveryEnvelope) =>
      recordActivationCompletion(service, journal),
    recordJournal: async (
      journal: InternalRecoveryEnvelope,
      expectedRevision: string,
    ) => {
      if (journal.owner !== owner)
        throw createWeaverError(
          "FORBIDDEN",
          "Journal belongs to a different control owner",
        );
      const previous =
        controlProjection(service).prepared().configuration.upgrades.journal[
          journal.runId
        ];
      if (
        previous &&
        canonicalInternalJson(previous) !== canonicalInternalJson(journal)
      )
        throw createWeaverError(
          "WRITER_CONFLICT",
          "Journal lifecycle updates require the maintenance executor",
        );
      if (previous) return { success: true, revision: service.revision };
      const prepared = await prepareInitialJournal(service, journal);
      return controlTransaction(service, "maintenance", ({ write }) =>
        write(`_weaver.upgrades.journal.${journal.runId}`, prepared, {
          expectedRevision,
          ...(prepared.control
            ? { operationId: prepared.control.operationId }
            : {}),
        }),
      );
    },
    repairStep: (runId: string, stepId: string, expectedRevision: string) =>
      repairControlStep(service, runId, stepId, owner, expectedRevision),
    readRecovery: (runId: string) => controlRecovery(service, runId),
  };
}

async function controlResult(
  operation: () => Promise<WriteResult>,
): Promise<WriteResult> {
  try {
    return await operation();
  } catch (error) {
    return {
      success: false,
      error: {
        code:
          error instanceof WeaverErrorInstance
            ? error.code
            : "VALIDATION_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
