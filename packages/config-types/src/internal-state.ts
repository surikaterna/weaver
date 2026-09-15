import { z } from "zod";
import { internalCatalogSchema, internalFormatSchema } from "./internal-config";
import { encodeInternalIdentity } from "./internal-identities";
import {
  checkScopeChain,
  internalInfrastructureSchema,
} from "./internal-infrastructure";
import { internalUpgradesSchema } from "./internal-upgrades";
import { scopeInventorySchema } from "./scope-inventory";

export const internalScopeInventorySchema = scopeInventorySchema.superRefine(
  (inventory, context) => {
    for (const [id, entry] of Object.entries(inventory.contexts)) {
      const expected = encodeInternalIdentity(
        entry.scopePath.map(({ scopeId, value }) => [scopeId, value]),
      );
      if (id !== expected)
        context.addIssue({
          code: "custom",
          message: "Scope context identity mismatch",
        });
      if (
        new Set(entry.scopePath.map((scope) => scope.scopeId)).size !==
        entry.scopePath.length
      )
        context.addIssue({
          code: "custom",
          message: "Duplicate context dimension",
        });
      checkPrefixes(inventory, entry, context);
    }
  },
);

function checkPrefixes(
  inventory: z.infer<typeof scopeInventorySchema>,
  entry: z.infer<typeof scopeInventorySchema>["contexts"][string],
  context: z.RefinementCtx,
): void {
  for (let length = 1; length < entry.scopePath.length; length++) {
    const id = encodeInternalIdentity(
      entry.scopePath
        .slice(0, length)
        .map(({ scopeId, value }) => [scopeId, value]),
    );
    const prefix = inventory.contexts[id];
    if (!prefix || (entry.state === "active" && prefix.state !== "active"))
      context.addIssue({
        code: "custom",
        message: "Scope inventory is missing an active prefix",
      });
  }
}

export const internalConfigurationSchema = z
  .strictObject({
    format: internalFormatSchema,
    catalog: internalCatalogSchema,
    infrastructure: internalInfrastructureSchema,
    scopeInventory: internalScopeInventorySchema,
    upgrades: internalUpgradesSchema,
  })
  .superRefine((state, context) => {
    if (
      !Object.hasOwn(
        state.infrastructure.generations,
        state.infrastructure.activeGeneration,
      )
    )
      return;
    const generation =
      state.infrastructure.generations[state.infrastructure.activeGeneration];
    if (!generation) return;
    for (const entry of Object.values(state.scopeInventory.contexts))
      checkScopeChain(
        entry.scopePath.map((scope) => scope.scopeId),
        generation.layout.scopes,
        context,
      );
    for (const record of Object.values(state.catalog.registrations)) {
      if (record.request.environment !== state.format.environment)
        context.addIssue({
          code: "custom",
          message: "Registration environment does not match control layer",
        });
    }
  });
export type InternalConfiguration = z.infer<typeof internalConfigurationSchema>;
