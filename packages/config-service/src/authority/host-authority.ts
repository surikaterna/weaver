import { withAuth } from "@weaver-conf/config-auth";
import {
  type AuthorizationRequest,
  authorizationDecisionSchema,
  type ConfigurationAuthorityCapability,
  type ConfigurationAuthorityController,
  type ConfigurationAuthorityRequest,
  type ConfigurationServiceIdentity,
  canonicalConfigurationPathSchema,
  configurationServiceIdentitySchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import { currentIdentity } from "../identity-state";
import { assertLive, type RootState } from "../root-state";
import { admitLeaf } from "./authority-read";
import {
  covers,
  identityMatches,
  requestFor,
  selectGrant,
} from "./authorization-requests";
import { createCapabilityRegistry, forbidden } from "./capability-registry";
import { createWriteExecutor } from "./governed-write";

type Prepare = (
  identity: ConfigurationServiceIdentity,
  guard: () => void,
) => Promise<void>;
export function createHostAuthority(state: RootState, prepare: Prepare) {
  const host = state.factory.host;
  const registry = createCapabilityRegistry(
    () => assertLive(state),
    host.now ?? Date.now,
  );
  const auth = host.authConfig ? withAuth(host.authConfig) : undefined;
  let bound: ConfigurationAuthorityCapability | undefined;
  const check = createReadCheck(state, registry, auth);
  const execution = {
    state,
    registry,
    check,
    prepare,
    write: createWriteExecutor(state, registry, auth),
  };
  const controller = controllerFor(execution, (token) => {
    selectNamespace(registry, token, state.factory.options.identity);
    bound = token;
  });
  return { controller, ...rootGates(execution, () => bound) };
}
function rootGates(
  execution: Execution,
  capture: () => ConfigurationAuthorityCapability | undefined,
) {
  const { registry } = execution;
  return {
    capture,
    ...rootWrites(execution, capture),
    assertBound: () => {
      const bound = capture();
      if (bound) registry.current(bound);
    },
    read(
      identity: ConfigurationServiceIdentity,
      path: string,
      operation: "read" | "inspect",
      layer?: string,
      aggregate = false,
    ): void {
      const token = capture();
      if (!token) return;
      rootRead(execution, token, identity, path, operation, layer, aggregate);
    },
    prepare(
      token: ConfigurationAuthorityCapability,
      identity: ConfigurationServiceIdentity,
    ): Promise<void> {
      return prepareRequest(
        execution,
        token,
        identity,
        selectNamespace(registry, token, identity),
      );
    },
  };
}
function rootRead(
  execution: Execution,
  token: ConfigurationAuthorityCapability,
  identity: ConfigurationServiceIdentity,
  path: string,
  operation: "read" | "inspect",
  layer: string | undefined,
  aggregate: boolean,
): void {
  const layers = requiredLayers(execution.state, identity, layer);
  const namespace = selectNamespace(
    execution.registry,
    token,
    identity,
    path,
    operation,
    layers,
  );
  execution.check(
    token,
    requestFor(identity, namespace, path, operation, layer),
    layers,
    !aggregate,
  );
  if (aggregate) forbidden();
}
function rootWrites(
  execution: Execution,
  capture: () => ConfigurationAuthorityCapability | undefined,
) {
  const identity = execution.state.factory.options.identity;
  return {
    set: (
      path: string,
      value: unknown,
      options: Parameters<ConfigurationAuthorityRequest["set"]>[2],
    ) =>
      execution.write(
        capture(),
        identity,
        undefined,
        path,
        "set",
        value,
        options,
      ),
    remove: (
      path: string,
      options: Parameters<ConfigurationAuthorityRequest["remove"]>[1],
    ) =>
      execution.write(
        capture(),
        identity,
        undefined,
        path,
        "remove",
        undefined,
        options,
      ),
  };
}
function selectNamespace(
  registry: ReturnType<typeof createCapabilityRegistry>,
  token: ConfigurationAuthorityCapability,
  identity: ConfigurationServiceIdentity,
  path?: string,
  operation?: "read" | "inspect",
  layers: readonly string[] = [],
): string {
  const grant = registry
    .current(token)
    .snapshot.grants.find(
      (item) =>
        identityMatches(item.identity, identity) &&
        (operation === undefined || item.operations.includes(operation)) &&
        layers.every((layer) => item.layers.includes(layer)) &&
        (path === undefined || covers(item.namespace, path)),
    );
  if (!grant) return forbidden();
  return grant.namespace;
}
function createReadCheck(
  state: RootState,
  registry: ReturnType<typeof createCapabilityRegistry>,
  auth: ReturnType<typeof withAuth> | undefined,
) {
  let checking = false;
  return (
    token: ConfigurationAuthorityCapability,
    request: AuthorizationRequest,
    layers: readonly string[],
    leaf: boolean,
  ): void => {
    assertLive(state);
    const host = state.factory.host;
    if (checking || !auth || !host.hostAuthority) forbidden();
    const entry = registry.current(token);
    if (
      request.identity.environment !==
      state.factory.options.identity.environment
    )
      forbidden();
    selectGrant(entry.snapshot, request, layers);
    if (
      layers.some(
        (layer) =>
          !state.factory.options.layers.some((slot) => slot.layer === layer),
      )
    )
      forbidden();
    if (leaf) admitLeaf(state.factory.registry, entry.snapshot, request, auth);
    checking = true;
    try {
      const decision = host.hostAuthority.authorizeReadSync(
        entry.snapshot,
        request,
      );
      rejectAsyncDecision(decision);
      if (authorizationDecisionSchema.safeParse(decision).data !== "allowed")
        forbidden();
    } catch {
      forbidden();
    } finally {
      checking = false;
    }
    registry.current(token);
    state.factory.assertRegistryStable();
  };
}
type Execution = {
  readonly state: RootState;
  readonly registry: ReturnType<typeof createCapabilityRegistry>;
  readonly check: (
    token: ConfigurationAuthorityCapability,
    request: AuthorizationRequest,
    layers: readonly string[],
    leaf: boolean,
  ) => void;
  readonly prepare: Prepare;
  readonly write: ReturnType<typeof createWriteExecutor>;
};
function rejectAsyncDecision(value: unknown): void {
  if (value instanceof Promise) {
    void Promise.prototype.then.call(value, undefined, () => {});
    forbidden();
  }
}
function requiredLayers(
  state: RootState,
  identity: ConfigurationServiceIdentity,
  layer?: string,
): readonly string[] {
  if (layer !== undefined) return [layer];
  return currentIdentity(state, identity).contributions.map(
    (item) => item.selection.captured.binding.layer,
  );
}
function captureSelection(
  execution: Execution,
  token: ConfigurationAuthorityCapability,
  input: ConfigurationServiceIdentity,
  path: string,
) {
  assertLive(execution.state);
  const identity = configurationServiceIdentitySchema.safeParse(input);
  const namespace = canonicalConfigurationPathSchema.safeParse(path);
  if (!identity.success || !namespace.success) return forbidden();
  const snapshot = execution.registry.current(token).snapshot;
  if (
    identity.data.environment !==
      execution.state.factory.options.identity.environment ||
    snapshot.session
  )
    forbidden();
  if (
    !snapshot.grants.some(
      (grant) =>
        identityMatches(grant.identity, identity.data) &&
        grant.namespace === namespace.data,
    )
  )
    forbidden();
  return { identity: identity.data, namespace: namespace.data };
}
function controllerFor(
  execution: Execution,
  bind: (token: ConfigurationAuthorityCapability) => void,
): ConfigurationAuthorityController {
  const { registry } = execution;
  return Object.freeze<ConfigurationAuthorityController>({
    mint: registry.mint,
    revoke: registry.revoke,
    replace(token, snapshot) {
      registry.revoke(token);
      return registry.mint(snapshot);
    },
    bindRoot(token) {
      registry.current(token);
      bind(token);
    },
    forIdentity(token, identity, namespace) {
      const selected = captureSelection(execution, token, identity, namespace);
      return requestPort(
        execution,
        token,
        selected.identity,
        selected.namespace,
      );
    },
  });
}
function prepareRequest(
  execution: Execution,
  token: ConfigurationAuthorityCapability,
  identity: ConfigurationServiceIdentity,
  namespace: string,
): Promise<void> {
  const layers = execution.state.factory.options.layers.map(
    (slot) => slot.layer,
  );
  const guard = () => {
    assertLive(execution.state);
    execution.check(
      token,
      requestFor(identity, namespace, namespace, "read"),
      layers,
      false,
    );
  };
  try {
    guard();
  } catch (error) {
    return Promise.reject(error);
  }
  return execution.prepare(identity, guard).then(guard);
}
function requestPort(
  execution: Execution,
  token: ConfigurationAuthorityCapability,
  identity: ConfigurationServiceIdentity,
  namespace: string,
): ConfigurationAuthorityRequest {
  const { state } = execution;
  const snapshot = (path: string, operation: "read" | "inspect") => {
    execution.registry.current(token);
    execution.check(
      token,
      requestFor(identity, namespace, path, operation),
      requiredLayers(state, identity),
      true,
    );
    return currentIdentity(state, identity);
  };
  return Object.freeze<ConfigurationAuthorityRequest>({
    get identity() {
      execution.registry.current(token);
      return identity;
    },
    get revision() {
      execution.registry.current(token);
      execution.check(
        token,
        requestFor(identity, namespace, namespace, "read"),
        requiredLayers(state, identity),
        false,
      );
      return currentIdentity(state, identity).revision;
    },
    prepare: () => prepareRequest(execution, token, identity, namespace),
    get: (path) => snapshot(path, "read").projection.get(path),
    inspect: (path) => snapshot(path, "inspect").projection.inspect(path),
    set: (path, value, options) =>
      execution.write(token, identity, namespace, path, "set", value, options),
    remove: (path, options) =>
      execution.write(
        token,
        identity,
        namespace,
        path,
        "remove",
        undefined,
        options,
      ),
  });
}

export function announceAuthority(state: RootState): void {
  if (!state.authority || !state.factory.host.onAuthorityReady) return;
  try {
    const result: unknown = state.factory.host.onAuthorityReady(
      state.authority.controller,
    );
    rejectAsyncDecision(result);
  } catch {
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Authority initialization failed",
    );
  }
}
