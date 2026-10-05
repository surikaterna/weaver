import { configurationServiceHostOptionsSchema } from "@weaver-conf/config-service";
import {
  type ConfigurationServiceIdentity,
  captureServiceData,
  configurationServiceOptionsSchema,
  createWeaverError,
  type TrustedPrincipalSnapshot,
} from "@weaver-conf/config-types";
import { z } from "zod";
import type { AuthContext } from "./auth/auth-middleware";
import { parseServerEnv } from "./server-env";

type PrincipalMapper = (
  verified: AuthContext,
  requestedIdentity: ConfigurationServiceIdentity,
) => TrustedPrincipalSnapshot;

function invalidOptions(): never {
  throw createWeaverError("VALIDATION_ERROR", "Invalid authority options");
}

function ownEnvelope(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return invalidOptions();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype)
    return invalidOptions();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== "string" || !field?.enumerable || !("value" in field))
      return invalidOptions();
    Object.defineProperty(result, key, {
      value: field.value,
      enumerable: true,
    });
  }
  return result;
}

const mapperSchema = z.custom<PrincipalMapper>(
  (value) => typeof value === "function",
);
const registrySelectionSchema = z.strictObject({
  providerId: z.string().min(1),
  layer: z.string().min(1),
});
const requiredHostSchema = configurationServiceHostOptionsSchema.transform(
  (host, context) => {
    if (!host.authConfig || !host.hostAuthority || !host.writers) {
      context.addIssue({
        code: "custom",
        message: "Explicit authority required",
      });
      return z.NEVER;
    }
    return {
      ...host,
      authConfig: host.authConfig,
      hostAuthority: host.hostAuthority,
      writers: host.writers,
    };
  },
);
const authorityShape = z
  .strictObject({
    configuration: configurationServiceOptionsSchema.refine(
      (configuration) => configuration.schemas.length === 0,
    ),
    registry: registrySelectionSchema,
    mapPrincipal: mapperSchema,
    host: requiredHostSchema,
  })
  .transform(({ host, ...options }) => ({
    ...options,
    authConfig: host.authConfig,
    hostAuthority: host.hostAuthority,
    writers: host.writers,
    ...(host.now === undefined ? {} : { now: host.now }),
    ...(host.audit === undefined ? {} : { audit: host.audit }),
  }));

function captureAuthority(input: unknown): unknown {
  const fields = ownEnvelope(input);
  const { configuration, registry, mapPrincipal, ...host } = fields;
  const mapper = mapperSchema.parse(mapPrincipal);
  const captured = captureServiceData(registry);
  if (!captured.success) return invalidOptions();
  if (
    Object.keys(host).some(
      (key) =>
        !["authConfig", "hostAuthority", "writers", "now", "audit"].includes(
          key,
        ),
    )
  )
    return invalidOptions();
  return {
    configuration,
    registry: captured.value,
    host,
    mapPrincipal: (
      context: AuthContext,
      identity: ConfigurationServiceIdentity,
    ) => Reflect.apply(mapper, input, [context, identity]),
  };
}

/** Trusted programmatic composition, not serialized credentials or grants. */
export const serverAuthorityOptionsSchema = z.preprocess((input, context) => {
  try {
    return captureAuthority(input);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid authority options" });
    return z.NEVER;
  }
}, authorityShape);
export type ServerAuthorityOptions = z.output<
  typeof serverAuthorityOptionsSchema
>;

export function hasAuthorityOptions(input: unknown): boolean {
  if (!input || typeof input !== "object" || !("authority" in input))
    return false;
  const field = Object.getOwnPropertyDescriptor(input, "authority");
  if (!field || !("value" in field) || !field.enumerable)
    return invalidOptions();
  return field.value !== undefined;
}

const pageSizeSchema = z.number().int().min(50).max(Number.MAX_SAFE_INTEGER);
const serverShape = z.strictObject({
  port: z.number().int().min(0).max(65535).optional(),
  environment: z.string().optional(),
  jwtSecret: z.string().min(1).optional(),
  corsOrigins: z.array(z.string()).optional(),
  schemaIdentityMaxPageSize: pageSizeSchema.optional(),
  authority: serverAuthorityOptionsSchema,
});

export function resolveAuthorityOptions(input: unknown) {
  try {
    const fields = ownEnvelope(input);
    const origins = captureServiceData(fields.corsOrigins);
    if (!origins.success) return invalidOptions();
    const options = serverShape.parse({
      ...fields,
      corsOrigins: origins.value,
    });
    const env = parseServerEnv({
      WEAVER_PORT: process.env.WEAVER_PORT,
      WEAVER_JWT_SECRET: process.env.WEAVER_JWT_SECRET,
      WEAVER_SCHEMA_IDENTITY_MAX_PAGE_SIZE:
        process.env.WEAVER_SCHEMA_IDENTITY_MAX_PAGE_SIZE,
    });
    const environment = options.authority.configuration.identity.environment;
    if (
      options.environment !== undefined &&
      options.environment !== environment
    )
      return invalidOptions();
    return {
      ...options,
      environment,
      port: options.port ?? env.WEAVER_PORT ?? 3399,
      jwtSecret: z
        .string()
        .min(1)
        .parse(options.jwtSecret ?? env.WEAVER_JWT_SECRET),
      schemaIdentityMaxPageSize:
        options.schemaIdentityMaxPageSize ??
        env.WEAVER_SCHEMA_IDENTITY_MAX_PAGE_SIZE ??
        200,
    };
  } catch {
    return invalidOptions();
  }
}
