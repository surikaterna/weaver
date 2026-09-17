import { z } from "zod";
import {
  credentialReferenceSchema,
  internalIdSchema,
} from "./internal-identities";

const localPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !value.includes("://") && !value.includes("\0"),
    "Expected a local path, not a URL or credential",
  );
const shared = { id: internalIdSchema };
const absoluteLocalPathSchema = localPathSchema.refine(
  (value) => value.startsWith("/"),
  "Expected an absolute local POSIX path",
);
const checkoutPathSchema = localPathSchema.refine(
  (value) => !value.startsWith("/") && !value.split("/").includes(".."),
  "Expected a checkout-relative path",
);

/** Installed factory IDs and their serialized option contracts; credentials are references only. */
export const internalProviderDefinitionSchema = z.discriminatedUnion(
  "factory",
  [
    z.strictObject({
      ...shared,
      factory: z.literal("fs"),
      options: z.strictObject({ filePath: absoluteLocalPathSchema }),
    }),
    z.strictObject({
      ...shared,
      factory: z.literal("git"),
      options: z.strictObject({
        localPath: absoluteLocalPathSchema,
        filePath: checkoutPathSchema,
        authority: z.literal("local-durable"),
        branch: internalIdSchema.optional(),
        remote: z
          .string()
          .url()
          .refine(
            isCredentialFreeRemote,
            "Remote URL must use HTTPS without credentials, query, or fragment",
          )
          .optional(),
      }),
      credentials: z
        .strictObject({ token: credentialReferenceSchema })
        .optional(),
    }),
    z.strictObject({
      ...shared,
      factory: z.literal("mongodb"),
      options: z.strictObject({
        database: internalIdSchema,
        collection: internalIdSchema,
      }),
      credentials: z.strictObject({ connection: credentialReferenceSchema }),
    }),
    z.strictObject({
      ...shared,
      factory: z.literal("memory"),
      options: z.strictObject({ durability: z.literal("volatile") }),
    }),
  ],
);
export type InternalProviderDefinition = z.infer<
  typeof internalProviderDefinitionSchema
>;

export const internalServerSettingsSchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  corsOrigins: z.array(z.string().url()).readonly().optional(),
  auth: z.strictObject({
    credentialRef: credentialReferenceSchema,
    adminRoles: z.array(z.string().min(1)).min(1).readonly(),
  }),
});
export type InternalServerSettings = z.infer<
  typeof internalServerSettingsSchema
>;

function isCredentialFreeRemote(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
