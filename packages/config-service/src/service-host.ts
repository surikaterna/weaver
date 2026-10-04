import type { AuthConfig } from "@weaver-conf/config-auth";
import type { CanonicalSchemaRegistryReader } from "@weaver-conf/config-registry";
import {
  type ConfigurationAuthorityAuditRecord,
  type ConfigurationAuthorityController,
  configurationHostAuthoritySchema,
  configurationProviderWriteBindingSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";
import {
  captureAuthConfig,
  captureData,
  capturePort,
  invalidHost,
  ownRecord,
  portMember,
} from "./authority/authority-contract-capture";

const registryMethods = [
  "getSchema",
  "resolveAnchor",
  "listAll",
  "listRegisteredSchemaIdentities",
  "listRegisteredSchemaIdentityPage",
  "getRegisteredSchema",
];
const registrySchema = z.custom<CanonicalSchemaRegistryReader>((value) => {
  if (!value || typeof value !== "object") return false;
  return registryMethods.every(
    (key) => typeof portMember(value, key) === "function",
  );
});
function callable<T>() {
  return z.custom<T>((value) => typeof value === "function");
}
const hostShape = z
  .strictObject({
    registry: registrySchema.optional(),
    hostAuthority: configurationHostAuthoritySchema.optional(),
    authConfig: z.custom<AuthConfig>().optional(),
    onAuthorityReady:
      callable<
        (controller: ConfigurationAuthorityController) => void
      >().optional(),
    now: callable<() => number>().optional(),
    writers: z
      .array(configurationProviderWriteBindingSchema)
      .readonly()
      .optional(),
    audit:
      callable<
        (record: ConfigurationAuthorityAuditRecord) => void | Promise<void>
      >().optional(),
  })
  .readonly();

function captureHost(input: unknown): unknown {
  const fields = ownRecord(input);
  if (
    fields.hostAuthority &&
    typeof fields.hostAuthority === "object" &&
    Object.getPrototypeOf(fields.hostAuthority) === Object.prototype
  ) {
    const port = ownRecord(fields.hostAuthority);
    if (
      Object.keys(port).some(
        (key) => !["authorizeReadSync", "authorizeWrite"].includes(key),
      )
    )
      invalidHost();
  }
  return {
    ...fields,
    ...(fields.hostAuthority === undefined
      ? {}
      : {
          hostAuthority: capturePort(fields.hostAuthority, [
            "authorizeReadSync",
            "authorizeWrite",
          ]),
        }),
    ...(fields.authConfig === undefined
      ? {}
      : { authConfig: captureAuthConfig(fields.authConfig) }),
    ...(fields.writers === undefined
      ? {}
      : { writers: captureData(fields.writers) }),
  };
}
/** Trusted composition shapes, never principal verification or capability minting. */
export const configurationServiceHostOptionsSchema = z.preprocess(
  (input, context) => {
    try {
      return captureHost(input);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid configuration host",
      });
      return z.NEVER;
    }
  },
  hostShape,
);
export type ConfigurationServiceHostOptions = z.output<
  typeof configurationServiceHostOptionsSchema
>;
