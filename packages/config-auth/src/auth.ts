import type {
  ConfigurationAccessContext,
  ConfigurationPropertySchema,
  LayerWritePolicy,
  WeaverConfig,
} from "@weaver-conf/config-types";

export interface VisibilityRoleMapping {
  admin: ReadonlySet<string>;
  platform: ReadonlySet<string>;
}

/** Trusted host policy configuration; this utility does not authenticate sessions. */
export interface AuthConfig {
  weaverConfig: WeaverConfig;
  visibilityRoles: VisibilityRoleMapping;
  layerWritePolicies: ReadonlyArray<LayerWritePolicy>;
  dynamicScopeRoles: ReadonlySet<string>;
  sessionLayer?: string | undefined;
}

export interface AuthFunctions {
  canRead(
    accessContext: ConfigurationAccessContext,
    key: string,
    propertySchema: ConfigurationPropertySchema | undefined,
  ): boolean;
  canWrite(
    accessContext: ConfigurationAccessContext,
    layer: string,
    key: string,
    propertySchema: ConfigurationPropertySchema | undefined,
  ): boolean;
  filterVisibleKeys(
    accessContext: ConfigurationAccessContext,
    entries: Record<string, unknown>,
    schemaMap: Map<string, ConfigurationPropertySchema>,
  ): Record<string, unknown>;
}

export function withAuth(config: AuthConfig): AuthFunctions {
  const canRead: AuthFunctions["canRead"] = (context, _key, schema) =>
    readable(config, context, schema);
  return {
    canRead,
    canWrite: (context, layer, _key, schema) =>
      writable(config, context, layer, schema),
    filterVisibleKeys: (context, entries, schemas) =>
      filterVisible(context, entries, schemas, canRead),
  };
}

function readable(
  config: AuthConfig,
  context: ConfigurationAccessContext,
  schema: ConfigurationPropertySchema | undefined,
): boolean {
  const visibility = schema?.["x-weaver"]?.visibility ?? "public";
  if (visibility === "public") return true;
  if (visibility === "internal") return false;
  return context.roles.some((role) =>
    config.visibilityRoles[visibility].has(role),
  );
}

function writable(
  config: AuthConfig,
  context: ConfigurationAccessContext,
  layer: string,
  schema: ConfigurationPropertySchema | undefined,
): boolean {
  const rank = config.weaverConfig.getRank(layer);
  if (!knownRank(rank)) return false;
  if (!ceilingAllows(config, context, layer, rank, schema)) return false;
  const policy = config.layerWritePolicies.find((item) => item.layer === layer);
  const permitted = policy
    ? context.roles.some((role) => policy.allowedRoles.includes(role))
    : context.roles.some((role) => config.dynamicScopeRoles.has(role));
  if (!permitted) return false;
  const restriction = schema?.["x-weaver"]?.writeRestriction;
  if (
    restriction?.length &&
    !context.roles.some((role) => restriction.includes(role))
  )
    return false;
  if (layer !== config.sessionLayer) return true;
  const mode = schema?.["x-weaver"]?.sessionMode ?? "allowed";
  if (mode === "blocked") return false;
  return mode !== "restricted" || context.trustedSession?.emergency === true;
}

function ceilingAllows(
  config: AuthConfig,
  context: ConfigurationAccessContext,
  layer: string,
  rank: number,
  schema: ConfigurationPropertySchema | undefined,
): boolean {
  const name = schema?.["x-weaver"]?.maxOverrideLayer;
  if (name === undefined) return true;
  const ceiling = config.weaverConfig.getRank(name);
  if (!knownRank(ceiling)) return false;
  return (
    rank <= ceiling ||
    (layer === config.sessionLayer &&
      context.trustedSession?.emergency === true)
  );
}

function knownRank(rank: number): boolean {
  return Number.isFinite(rank) && rank >= 0;
}

function filterVisible(
  context: ConfigurationAccessContext,
  entries: Record<string, unknown>,
  schemas: Map<string, ConfigurationPropertySchema>,
  canRead: AuthFunctions["canRead"],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(entries)) {
    if (canRead(context, key, schemas.get(key))) result[key] = entries[key];
  }
  return result;
}
