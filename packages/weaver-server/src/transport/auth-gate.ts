// Auth gate — bridges weaver-server AuthContext to config-auth RBAC functions
import type { AuthFunctions } from "@weaver-conf/config-auth";
import type {
  ConfigurationAccessContext,
  ConfigurationPropertySchema,
} from "@weaver-conf/config-types";
import { z } from "zod";
import type { AuthContext } from "../auth/auth-middleware";
import type { RestResponse } from "./rest-adapter";

export interface AuthGate {
  toAccessContext(authCtx: AuthContext): ConfigurationAccessContext;
  gateSchemaWrite(accessCtx: ConfigurationAccessContext): RestResponse | null;
  gateRead(
    accessCtx: ConfigurationAccessContext,
    key: string,
    schema?: ConfigurationPropertySchema,
  ): RestResponse | null;
  gateWrite(
    accessCtx: ConfigurationAccessContext,
    layer: string,
    key: string,
    schema?: ConfigurationPropertySchema,
  ): RestResponse | null;
  filterVisible(
    accessCtx: ConfigurationAccessContext,
    entries: Record<string, unknown>,
    schemaMap: Map<string, ConfigurationPropertySchema>,
  ): Record<string, unknown>;
}

export interface AuthGateOptions {
  authFunctions: AuthFunctions;
  /** Map AuthContext to ConfigurationAccessContext — caller provides the mapping logic */
  mapContext: (authCtx: AuthContext) => ConfigurationAccessContext;
  /** Schema management roles, independent of configuration-layer write policy. */
  schemaAdminRoles?: readonly string[] | undefined;
  /** Synchronous narrowing only; cannot grant authority missing from the role policy. */
  canRegisterSchema?:
    | ((accessCtx: ConfigurationAccessContext) => boolean)
    | undefined;
}

const callable = <T>() => z.custom<T>((value) => typeof value === "function");
const schemaWritePolicySchema = z.strictObject({
  schemaAdminRoles: z.array(z.string().min(1)).readonly().optional(),
  canRegisterSchema:
    callable<NonNullable<AuthGateOptions["canRegisterSchema"]>>().optional(),
});
export const authGateOptionsSchema = schemaWritePolicySchema.extend({
  authFunctions: z.strictObject({
    canRead: callable<AuthFunctions["canRead"]>(),
    canWrite: callable<AuthFunctions["canWrite"]>(),
    filterVisibleKeys: callable<AuthFunctions["filterVisibleKeys"]>(),
  }),
  mapContext: callable<AuthGateOptions["mapContext"]>(),
}) satisfies z.ZodType<AuthGateOptions>;
export const authGateSchema = z.strictObject({
  toAccessContext: callable<AuthGate["toAccessContext"]>(),
  gateSchemaWrite: callable<AuthGate["gateSchemaWrite"]>(),
  gateRead: callable<AuthGate["gateRead"]>(),
  gateWrite: callable<AuthGate["gateWrite"]>(),
  filterVisible: callable<AuthGate["filterVisible"]>(),
}) satisfies z.ZodType<AuthGate>;

function forbidden(message: string): RestResponse {
  return {
    status: 403,
    body: {
      data: null,
      meta: { revision: "", timestamp: new Date().toISOString() },
      error: { code: "FORBIDDEN", message },
    },
    headers: { "Content-Type": "application/json" },
  };
}

export function createAuthGate(options: AuthGateOptions): AuthGate {
  const { authFunctions, mapContext } = options;
  const gateSchemaWrite = createSchemaWriteGate(options);

  function toAccessContext(authCtx: AuthContext): ConfigurationAccessContext {
    return mapContext(authCtx);
  }

  function gateRead(
    accessCtx: ConfigurationAccessContext,
    key: string,
    schema?: ConfigurationPropertySchema,
  ): RestResponse | null {
    if (!authFunctions.canRead(accessCtx, key, schema ?? undefined)) {
      return forbidden(`Read access denied for key: ${key}`);
    }
    return null;
  }

  function gateWrite(
    accessCtx: ConfigurationAccessContext,
    layer: string,
    key: string,
    schema?: ConfigurationPropertySchema,
  ): RestResponse | null {
    if (!authFunctions.canWrite(accessCtx, layer, key, schema ?? undefined)) {
      return forbidden(
        `Write access denied for key: ${key} on layer: ${layer}`,
      );
    }
    return null;
  }

  function filterVisible(
    accessCtx: ConfigurationAccessContext,
    entries: Record<string, unknown>,
    schemaMap: Map<string, ConfigurationPropertySchema>,
  ): Record<string, unknown> {
    return authFunctions.filterVisibleKeys(accessCtx, entries, schemaMap);
  }

  return {
    toAccessContext,
    gateSchemaWrite,
    gateRead,
    gateWrite,
    filterVisible,
  };
}

function createSchemaWriteGate(
  options: AuthGateOptions,
): AuthGate["gateSchemaWrite"] {
  const parsed = schemaWritePolicySchema.safeParse({
    schemaAdminRoles: options.schemaAdminRoles,
    canRegisterSchema: options.canRegisterSchema,
  });
  const roles = new Set(parsed.success ? parsed.data.schemaAdminRoles : []);
  const narrow = parsed.success ? parsed.data.canRegisterSchema : undefined;
  return (context) => {
    try {
      if (
        context.roles.some((role) => roles.has(role)) &&
        (!narrow || narrowSchemaWrite(narrow, context))
      )
        return null;
    } catch {
      // Host policy failures cannot release schema management authority.
    }
    return forbidden("Schema write access denied");
  };
}

function narrowSchemaWrite(
  narrow: NonNullable<AuthGateOptions["canRegisterSchema"]>,
  context: ConfigurationAccessContext,
): boolean {
  const decision: unknown = narrow(context);
  if (decision === true) return true;
  // Consume rejected promises/thenables, but never await them to authorize a write.
  void Promise.resolve(decision).catch(() => {});
  return false;
}
