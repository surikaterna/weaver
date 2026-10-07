import type { AuthConfig } from "@weaver-conf/config-auth";
import {
  sessionDurationSchema,
  sessionTimerSchema,
} from "@weaver-conf/config-sessions";
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
} from "./authority/authority-contract-capture";

const registrySchema = z
  .strictObject({
    initial: z.unknown().optional(),
    storage: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("memory") }),
        z.strictObject({
          kind: z.literal("provider"),
          providerId: z.string().min(1),
        }),
      ])
      .optional(),
    schemaIdentityMaxPageSize: z.number().int().positive().safe().optional(),
  })
  .readonly();
function callable<T>() {
  return z.custom<T>((value) => typeof value === "function");
}
const hostShape = z
  .strictObject({
    sessions: z
      .strictObject({
        defaultDurationMs: sessionDurationSchema,
        maxDurationMs: sessionDurationSchema,
        maxActiveSessions: z.number().int().positive().safe(),
        timer: sessionTimerSchema.optional(),
      })
      .refine((value) => value.defaultDurationMs <= value.maxDurationMs)
      .readonly()
      .optional(),
    registry: registrySchema.optional(),
    hostAuthority: configurationHostAuthoritySchema,
    authConfig: z.custom<AuthConfig>((value) => value !== undefined),
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
    ...(fields.sessions === undefined
      ? {}
      : { sessions: captureSessions(fields.sessions) }),
    ...(fields.registry === undefined
      ? {}
      : { registry: captureData(fields.registry) }),
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
function captureSessions(input: unknown): unknown {
  const fields = ownRecord(input);
  const { timer, ...data } = fields;
  return {
    ...ownRecord(captureData(data)),
    ...(timer === undefined
      ? {}
      : { timer: capturePort(timer, ["setTimeout", "clearTimeout"]) }),
  };
}
/** Trusted composition shapes, never principal verification or capability minting. */
function captureHostInput(input: unknown, context: z.RefinementCtx) {
  try {
    return captureHost(input);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Invalid configuration host",
    });
    return z.NEVER;
  }
}
export const configurationServiceHostBindingSchema = z.preprocess(
  captureHostInput,
  hostShape,
);
export const configurationServiceHostOptionsSchema = z.preprocess(
  captureHostInput,
  hostShape
    .unwrap()
    .extend({
      onAuthorityReady:
        callable<(controller: ConfigurationAuthorityController) => void>(),
    })
    .readonly(),
);
export type ConfigurationServiceHostOptions = z.output<
  typeof configurationServiceHostOptionsSchema
>;
