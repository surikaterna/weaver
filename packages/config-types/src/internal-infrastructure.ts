import { z } from "zod";
import { internalIdSchema } from "./internal-identities";
import {
  internalProviderDefinitionSchema,
  internalServerSettingsSchema,
} from "./internal-providers";
import { scopeDefinitionSchema } from "./schemas-layers";

export const internalScopeDefinitionSchema = scopeDefinitionSchema.extend({
  id: internalIdSchema,
  parentScopeId: internalIdSchema.optional(),
  label: z.string().min(1),
});
export const internalLayerDefinitionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    name: internalIdSchema,
    type: z.literal("static"),
    providerId: internalIdSchema,
    config: z.strictObject({ mergeId: z.literal("deep") }),
  }),
  z.strictObject({
    name: internalIdSchema,
    type: z.literal("dynamic"),
    providerId: internalIdSchema,
    config: z.strictObject({
      mergeId: z.literal("deep"),
      scopeIds: z.array(internalIdSchema).min(1).readonly(),
    }),
  }),
  z.strictObject({
    name: internalIdSchema,
    type: z.enum(["personal", "ephemeral"]),
    providerId: internalIdSchema,
    config: z.strictObject({ mergeId: z.literal("deep") }),
  }),
]);
export type InternalLayerDefinition = z.infer<
  typeof internalLayerDefinitionSchema
>;

export const internalLayoutSchema = z
  .strictObject({
    layers: z.array(internalLayerDefinitionSchema).min(1).readonly(),
    scopes: z.array(internalScopeDefinitionSchema).readonly(),
  })
  .superRefine((layout, context) => {
    uniqueIds(
      layout.layers.map((layer) => layer.name),
      "layer",
      context,
    );
    uniqueIds(
      layout.scopes.map((scope) => scope.id),
      "scope",
      context,
    );
    checkScopeGraph(layout.scopes, context);
    for (const layer of layout.layers) {
      if (layer.type !== "dynamic") continue;
      checkLayerScopes(layer.config.scopeIds, layout.scopes, context);
    }
  });
export type InternalLayout = z.infer<typeof internalLayoutSchema>;

function checkLayerScopes(
  ids: readonly string[],
  scopes: readonly z.infer<typeof internalScopeDefinitionSchema>[],
  context: z.RefinementCtx,
): void {
  uniqueIds(ids, "scope reference", context);
  if (ids.length > 1) {
    checkScopeChain(ids, scopes, context);
    return;
  }
  for (const id of ids)
    if (!scopes.some((scope) => scope.id === id))
      context.addIssue({ code: "custom", message: `Unknown scope ${id}` });
}

export const internalInfrastructureGenerationSchema = z
  .strictObject({
    version: z.literal(1),
    layout: internalLayoutSchema,
    providers: z.array(internalProviderDefinitionSchema).min(1).readonly(),
    server: internalServerSettingsSchema,
  })
  .superRefine((generation, context) => {
    uniqueIds(
      generation.providers.map((provider) => provider.id),
      "provider",
      context,
    );
    for (const layer of generation.layout.layers) {
      if (
        !generation.providers.some(
          (provider) => provider.id === layer.providerId,
        )
      )
        context.addIssue({
          code: "custom",
          message: `Unknown provider ${layer.providerId}`,
        });
    }
  });
export type InternalInfrastructureGeneration = z.infer<
  typeof internalInfrastructureGenerationSchema
>;

export const internalInfrastructureSchema = z
  .strictObject({
    activeGeneration: internalIdSchema,
    generations: z.record(
      internalIdSchema,
      internalInfrastructureGenerationSchema,
    ),
  })
  .superRefine((value, context) => {
    if (!Object.hasOwn(value.generations, value.activeGeneration))
      context.addIssue({
        code: "custom",
        message: "Active infrastructure generation is missing",
      });
  });
export type InternalInfrastructure = z.infer<
  typeof internalInfrastructureSchema
>;

function uniqueIds(
  ids: readonly string[],
  field: string,
  context: z.RefinementCtx,
): void {
  if (new Set(ids).size !== ids.length)
    context.addIssue({
      code: "custom",
      message: `Duplicate ${field} identity`,
    });
}

function checkScopeGraph(
  scopes: readonly z.infer<typeof internalScopeDefinitionSchema>[],
  context: z.RefinementCtx,
): void {
  for (const scope of scopes) {
    const chain = new Set<string>();
    let current: typeof scope | undefined = scope;
    while (current) {
      if (chain.has(current.id)) {
        context.addIssue({ code: "custom", message: "Scope hierarchy cycle" });
        break;
      }
      chain.add(current.id);
      const parent: string | undefined = current.parentScopeId;
      current = scopes.find((candidate) => candidate.id === parent);
      if (parent && !current)
        context.addIssue({
          code: "custom",
          message: `Unknown parent scope ${parent}`,
        });
    }
  }
}

export function checkScopeChain(
  ids: readonly string[],
  scopes: readonly z.infer<typeof internalScopeDefinitionSchema>[],
  context: z.RefinementCtx,
): void {
  for (const [index, id] of ids.entries()) {
    const scope = scopes.find((candidate) => candidate.id === id);
    if (!scope || scope.parentScopeId !== ids[index - 1])
      context.addIssue({
        code: "custom",
        message: `Invalid scope hierarchy/order at ${id}`,
      });
  }
}
