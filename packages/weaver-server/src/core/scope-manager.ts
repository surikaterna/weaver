import {
  canonicalInternalJson,
  createWeaverError,
  internalScopeInventorySchema,
  type ScopeDefinition,
  type ScopeInstance,
  type ScopeInventory,
  type ScopeLifecycleRequest,
  type ScopeLifecycleResult,
  scopeLifecycleRequestSchema,
  scopeLifecycleResultSchema,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import {
  controlProjection,
  controlTransaction,
} from "./config-service-internal";
import type { WeaverConfigService } from "./config-service-types";
import { writeResultError } from "./config-write-errors";
import type { SchemaRegistry } from "./schema-registry";
import { scopeContextId } from "./scope-inventory";

export type ProvisionScopeRequest = ScopeLifecycleRequest;
export type DeprovisionScopeRequest = ScopeLifecycleRequest;
export type ScopeProvisionResult = ScopeLifecycleResult;
export interface ScopeManagerOptions {
  configService: WeaverConfigService;
  schemaRegistry?: SchemaRegistry;
}
export interface ScopeManager {
  provision(request: ProvisionScopeRequest): Promise<ScopeProvisionResult>;
  deprovision(request: DeprovisionScopeRequest): Promise<ScopeProvisionResult>;
  listScopeValues(scopeId: string): string[];
  listScopes(): ScopeDefinition[];
}

export function createScopeManager({
  configService: service,
}: ScopeManagerOptions): ScopeManager {
  const configuration = () =>
    controlProjection(service).prepared().configuration;
  return {
    provision: (request) => transition(service, request, "active"),
    deprovision: (request) => transition(service, request, "retired"),
    listScopeValues: (scopeId) =>
      activeScopeValues(configuration().scopeInventory, scopeId),
    listScopes: () => {
      const state = configuration();
      const generation =
        state.infrastructure.generations[state.infrastructure.activeGeneration];
      return structuredClone([...(generation?.layout.scopes ?? [])]);
    },
  };
}

function activeScopeValues(
  inventory: ScopeInventory,
  scopeId: string,
): string[] {
  const values = Object.values(inventory.contexts)
    .filter((entry) => entry.state === "active")
    .flatMap((entry) =>
      entry.scopePath
        .filter((scope) => scope.scopeId === scopeId)
        .map((scope) => scope.value),
    );
  return [...new Set(values)];
}

function normalizedPath(request: ScopeLifecycleRequest): ScopeInstance[] {
  if (request.scopePath) return request.scopePath;
  if (!request.scopeId || !request.value)
    throw createWeaverError("VALIDATION_ERROR", "Missing scope path");
  return [{ scopeId: request.scopeId, value: request.value }];
}

function assertRetirement(
  inventory: ScopeInventory,
  scopePath: ScopeInstance[],
): void {
  const id = scopeContextId(scopePath);
  if (!inventory.contexts[id])
    throw createWeaverError("SCOPE_NOT_FOUND", "Scope is not provisioned");
  const hasActiveChildren = Object.values(inventory.contexts).some(
    (entry) =>
      entry.state === "active" &&
      entry.scopePath.length > scopePath.length &&
      scopeContextId(entry.scopePath.slice(0, scopePath.length)) === id,
  );
  if (hasActiveChildren)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Retire active child contexts first",
    );
}

function updateInventory(
  inventory: ScopeInventory,
  scopePath: ScopeInstance[],
  request: ScopeLifecycleRequest,
  state: "active" | "retired",
): boolean {
  const id = scopeContextId(scopePath);
  if (state === "retired") assertRetirement(inventory, scopePath);
  const previous = inventory.contexts[id];
  const displayName = request.displayName ?? previous?.displayName;
  const next = {
    scopePath,
    state,
    ...(displayName !== undefined ? { displayName } : {}),
  };
  if (canonicalInternalJson(previous ?? null) === canonicalInternalJson(next))
    return false;
  inventory.contexts[id] = next;
  inventory.revision = String(BigInt(inventory.revision) + 1n);
  return true;
}

async function transition(
  service: WeaverConfigService,
  input: ScopeLifecycleRequest,
  state: "active" | "retired",
): Promise<ScopeProvisionResult> {
  try {
    const request = scopeLifecycleRequestSchema.parse(input);
    const scopePath = normalizedPath(request);
    return await controlTransaction(
      service,
      "scope",
      async ({ read, write }) => {
        if (
          request.expectedRevision !== undefined &&
          request.expectedRevision !== service.revision
        )
          throw createWeaverError(
            "REVISION_CONFLICT",
            "Scope inventory precondition changed",
          );
        const inventory = internalScopeInventorySchema.parse(read());
        if (updateInventory(inventory, scopePath, request, state)) {
          const result = await write("_weaver.scopeInventory", inventory, {
            expectedRevision: service.revision,
          });
          if (!result.success) throw writeResultError(result);
        }
        return scopeLifecycleResultSchema.parse({
          success: true,
          scopePath,
          revision: service.revision,
          inventoryRevision: inventory.revision,
        });
      },
    );
  } catch (error) {
    return scopeLifecycleResultSchema.parse({
      success: false,
      error:
        error instanceof WeaverErrorInstance
          ? error
          : createWeaverError("VALIDATION_ERROR", String(error)),
    });
  }
}
