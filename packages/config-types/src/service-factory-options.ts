import { z } from "zod";
import type { ConfigurationStorageProvider } from "./providers";
import type { SchemaRegistrationRequest } from "./schema-registration";
import { scopeInstanceSchema } from "./schemas-layers";
import {
  providerIdSchema,
  registrationEnvironmentSchema,
} from "./schemas-registration-paths";
import {
  fragmentSchemaRegistrationRequestSchema,
  serviceSchemaRegistrationRequestSchema,
} from "./schemas-schema-registration";
import { configurationServiceIdentitySchema } from "./schemas-service-capabilities";
import type { ConfigurationServiceIdentity } from "./service-capabilities";
import {
  captureConfigurationServiceOptions,
  isConfigurationStorageCapability,
} from "./service-factory-captures";
import type { ConfigurationLayerData } from "./types";

const layer = z.string().min(1);
const scopes = z.array(scopeInstanceSchema.readonly()).readonly();
export const configurationServiceLayerSlotSchema = z
  .strictObject({
    kind: z.enum(["fixed", "scope"]),
    layer,
    providerIds: z.array(providerIdSchema).min(1).readonly(),
  })
  .readonly();
export type ConfigurationServiceLayerSlot = z.infer<
  typeof configurationServiceLayerSlotSchema
>;

export const configurationServiceProviderEnvironmentSchema =
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("common") }).readonly(),
    z
      .strictObject({
        kind: z.literal("environments"),
        environments: z.array(registrationEnvironmentSchema).min(1).readonly(),
      })
      .readonly(),
  ]);
export type ConfigurationServiceProviderEnvironment = z.infer<
  typeof configurationServiceProviderEnvironmentSchema
>;

export const configurationServiceProviderReadContextSchema = z
  .strictObject({
    identity: configurationServiceIdentitySchema,
    layer,
    scopePath: scopes,
  })
  .readonly();
export type ConfigurationServiceProviderReadContext = Readonly<{
  identity: ConfigurationServiceIdentity;
  layer: string;
  scopePath: z.infer<typeof scopes>;
}>;
export const configurationServiceProviderReadSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("load") }).readonly(),
    z.strictObject({ kind: z.literal("load-layer"), layer }).readonly(),
    z
      .strictObject({
        kind: z.literal("read"),
        read: z.custom<
          (
            context: ConfigurationServiceProviderReadContext,
          ) => Promise<ConfigurationLayerData>
        >((value) => typeof value === "function"),
      })
      .readonly(),
  ],
);
export type ConfigurationServiceProviderRead = z.infer<
  typeof configurationServiceProviderReadSchema
>;
export const configurationServiceProviderOwnershipSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("borrowed") }).readonly(),
    z
      .strictObject({
        kind: z.literal("owned"),
        dispose: z.custom<() => void | Promise<void>>(
          (value) => typeof value === "function",
        ),
      })
      .readonly(),
  ],
);
export type ConfigurationServiceProviderOwnership = z.infer<
  typeof configurationServiceProviderOwnershipSchema
>;
export const configurationServiceProviderBindingSchema = z
  .strictObject({
    id: providerIdSchema,
    layer,
    provider: z.custom<ConfigurationStorageProvider>(
      isConfigurationStorageCapability,
    ),
    environment: configurationServiceProviderEnvironmentSchema,
    scopePath: scopes.optional(),
    operation: configurationServiceProviderReadSchema,
    ownership: configurationServiceProviderOwnershipSchema,
  })
  .readonly();
export type ConfigurationServiceProviderBinding = z.infer<
  typeof configurationServiceProviderBindingSchema
>;

const optionsSchema = z
  .strictObject({
    identity: configurationServiceIdentitySchema,
    schemas: z
      .array(
        z.union([
          serviceSchemaRegistrationRequestSchema,
          fragmentSchemaRegistrationRequestSchema,
        ]),
      )
      .readonly(),
    layers: z.array(configurationServiceLayerSlotSchema).min(1).readonly(),
    providers: z.array(configurationServiceProviderBindingSchema).readonly(),
    failureMode: z.enum(["fail", "allow-degraded"]).optional(),
  })
  .readonly();
export type ConfigurationServiceOptions = Readonly<{
  identity: ConfigurationServiceIdentity;
  schemas: readonly SchemaRegistrationRequest[];
  layers: readonly ConfigurationServiceLayerSlot[];
  providers: readonly ConfigurationServiceProviderBinding[];
  failureMode?: "fail" | "allow-degraded" | undefined;
}>;
export const configurationServiceOptionsSchema: z.ZodType<ConfigurationServiceOptions> =
  z.preprocess((input, context) => {
    try {
      return captureConfigurationServiceOptions(input);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid factory input" });
      return z.NEVER;
    }
  }, optionsSchema);
