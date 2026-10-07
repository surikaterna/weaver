import {
  authorizationDecisionSchema,
  type ConfigurationAuthorityCapability,
  type ConfigurationSchemaAuthorityRequest,
  captureServiceData,
  createWeaverError,
  registeredSchemaIdentityPageRequestSchema,
  type SchemaAuthorizationRequest,
  schemaAuthorizationRequestSchema,
  schemaDetailSchema,
  schemaIdentityPageSchema,
  schemaOperationOptionsSchema,
  schemaSnapshotSchema,
  type TrustedPrincipalSnapshot,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import { assertLive, assertReadable, type RootState } from "../root-state";
import { invokeWriteHook } from "./authority-audit";
import { covers } from "./authorization-requests";
import {
  type createCapabilityRegistry,
  forbidden,
} from "./capability-registry";
import { schemaRevision } from "./schema-publication";
import { registerSchema } from "./schema-registration";

export type SchemaRegistry = ReturnType<typeof createCapabilityRegistry>;

export function requireSchemaPermission(
  state: RootState,
  registry: SchemaRegistry,
  token: unknown,
  permission: "read" | "register",
): TrustedPrincipalSnapshot {
  assertLive(state);
  const principal = registry.current(token).snapshot;
  if (principal.session || !principal.schemaPermissions?.includes(permission))
    forbidden();
  return principal;
}

export function requireSchemaTarget(
  principal: TrustedPrincipalSnapshot,
  path: string,
  environment: string,
): void {
  if (
    !principal.grants.some(
      (grant) =>
        grant.identity.environment === environment &&
        grant.identity.scopePath.length === 0 &&
        covers(grant.namespace, path),
    )
  )
    forbidden();
}

function readSchema(
  state: RootState,
  registry: SchemaRegistry,
  token: unknown,
  request: SchemaAuthorizationRequest,
): void {
  assertReadable(state);
  const principal = requireSchemaPermission(state, registry, token, "read");
  if ("anchorPath" in request)
    requireSchemaTarget(principal, request.anchorPath, request.environment);
  else {
    const identities = state.factory.registry.listRegisteredSchemaIdentities();
    for (const identity of [...identities.anchors, ...identities.slots])
      requireSchemaTarget(principal, identity.path, identity.environment);
  }
  try {
    const decision: unknown = invokeWriteHook(state, () =>
      state.factory.host.hostAuthority?.authorizeReadSync(principal, request),
    );
    if (decision instanceof Promise)
      void Promise.prototype.then.call(decision, undefined, () => {});
    if (authorizationDecisionSchema.safeParse(decision).data !== "allowed")
      forbidden();
  } catch {
    forbidden();
  }
  requireSchemaPermission(state, registry, token, "read");
  assertReadable(state);
}

export function checkSchemaRevision(state: RootState, options: unknown): void {
  const parsed = schemaOperationOptionsSchema.safeParse(
    options === undefined ? {} : options,
  );
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid schema options");
  if (
    parsed.data.ifRevision !== undefined &&
    parsed.data.ifRevision !== schemaRevision(state)
  )
    throw createWeaverError("REVISION_CONFLICT", "Schema revision changed");
}

function detached<T>(value: T): T {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const children: unknown[] = Object.values(item);
    pending.push(...children);
    Object.freeze(item);
  }
  return value;
}

function query<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw createWeaverError(
      error instanceof WeaverErrorInstance ? error.code : "VALIDATION_ERROR",
      "Schema query rejected",
    );
  }
}

export function createSchemaAuthority(
  state: RootState,
  registry: SchemaRegistry,
  token: ConfigurationAuthorityCapability,
): ConfigurationSchemaAuthorityRequest {
  registry.current(token);
  const access = { state, registry, token };
  return Object.freeze({
    get revision() {
      readSchema(state, registry, token, {
        operation: "schema-read",
        query: "snapshot",
      });
      return schemaRevision(state);
    },
    register: (request, options) =>
      registerSchema(state, registry, token, request, options),
    snapshot: () => query(() => readSnapshot(access)),
    list: (request) => query(() => readPage(access, request)),
    get: (path, environment, options) =>
      query(() => readDetail(access, path, environment, options)),
  } satisfies ConfigurationSchemaAuthorityRequest);
}

type Access = {
  readonly state: RootState;
  readonly registry: SchemaRegistry;
  readonly token: ConfigurationAuthorityCapability;
};

function readSnapshot({ state, registry, token }: Access) {
  readSchema(state, registry, token, {
    operation: "schema-read",
    query: "snapshot",
  });
  const snapshot = state.factory.adapter.snapshot();
  return detached(
    schemaSnapshotSchema.parse({
      revision: schemaRevision(state),
      anchors: [...snapshot.schemas.values()],
      slots: [...snapshot.slots.values()],
    }),
  );
}

function readPage(
  { state, registry, token }: Access,
  request: Parameters<ConfigurationSchemaAuthorityRequest["list"]>[0],
) {
  readSchema(state, registry, token, {
    operation: "schema-read",
    query: "list",
  });
  const captured = captureServiceData(request);
  if (!captured.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid schema page");
  const input = registeredSchemaIdentityPageRequestSchema
    .optional()
    .parse(captured.value);
  return detached(
    schemaIdentityPageSchema.parse({
      revision: schemaRevision(state),
      page: state.factory.registry.listRegisteredSchemaIdentityPage(input),
    }),
  );
}

function readDetail(
  { state, registry, token }: Access,
  anchorPath: string,
  environment: string,
  options: Parameters<ConfigurationSchemaAuthorityRequest["get"]>[2],
) {
  assertReadable(state);
  requireSchemaPermission(state, registry, token, "read");
  const request = schemaAuthorizationRequestSchema.parse({
    operation: "schema-read",
    query: "get",
    anchorPath,
    environment,
  });
  readSchema(state, registry, token, request);
  checkSchemaRevision(state, options);
  return detached(
    schemaDetailSchema.parse({
      revision: schemaRevision(state),
      detail: state.factory.registry.getRegisteredSchema(
        anchorPath,
        environment,
      ),
    }),
  );
}
