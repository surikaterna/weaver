import type { AuthFunctions } from "@weaver-conf/config-auth";
import type {
  RegisteredReadAccess,
  RegisteredReadAccessEvidence,
} from "@weaver-conf/config-registry";
import {
  authorizationDecisionSchema,
  type ConfigurationAuthorityCapability,
  type ConfigurationAuthorizationRequest,
} from "@weaver-conf/config-types";
import { assertReadable, type RootState } from "../root-state";
import {
  evidencePath,
  grantAllows,
  selectGrant,
} from "./authorization-requests";
import {
  type createCapabilityRegistry,
  forbidden,
} from "./capability-registry";

type ReadRequest = Extract<
  ConfigurationAuthorizationRequest,
  { operation: "read" | "inspect" }
>;
type Registry = ReturnType<typeof createCapabilityRegistry>;

export function createReadCheck(
  state: RootState,
  registry: Registry,
  auth: AuthFunctions,
) {
  const decisions = createReadDecisions(state, registry);
  return (
    token: ConfigurationAuthorityCapability,
    request: ConfigurationAuthorizationRequest,
    layers: readonly string[],
    inspectData: boolean,
  ): RegisteredReadAccess => {
    assertReadable(state);
    decisions.assertIdle();
    if (request.operation === "write") return forbidden();
    const principal = registry.current(token).snapshot;
    if (
      request.identity.environment !==
      state.factory.options.identity.environment
    )
      return forbidden();
    selectGrant(principal, request, layers);
    if (
      layers.some(
        (layer) =>
          !state.factory.options.layers.some((slot) => slot.layer === layer),
      )
    )
      return forbidden();
    if (!inspectData && !decisions.authorize(token, request))
      return forbidden();
    return (evidence) =>
      readAccess(
        state,
        registry,
        auth,
        token,
        request,
        layers,
        evidence,
        decisions.authorize,
      );
  };
}

function createReadDecisions(state: RootState, registry: Registry) {
  let checking = false;
  const assertIdle = () => {
    if (checking) forbidden();
  };
  return {
    assertIdle,
    authorize(
      token: ConfigurationAuthorityCapability,
      request: ReadRequest,
    ): boolean {
      assertReadable(state);
      assertIdle();
      const principal = registry.current(token).snapshot;
      checking = true;
      try {
        const allowed = readDecision(() =>
          state.factory.host.hostAuthority.authorizeReadSync(
            principal,
            request,
          ),
        );
        registry.current(token);
        assertReadable(state);
        return allowed;
      } finally {
        checking = false;
      }
    },
  };
}

function readAccess(
  state: RootState,
  registry: Registry,
  auth: AuthFunctions,
  token: ConfigurationAuthorityCapability,
  request: ReadRequest,
  layers: readonly string[],
  evidence: RegisteredReadAccessEvidence,
  authorize: (
    token: ConfigurationAuthorityCapability,
    request: ReadRequest,
  ) => boolean,
): boolean {
  assertReadable(state);
  const principal = registry.current(token).snapshot;
  const path = evidence.path.length ? evidencePath(evidence.path) : "/";
  const next = Object.freeze({
    ...request,
    path,
    sensitive: evidence.sensitive,
    ...(evidence.layer === undefined ? {} : { layer: evidence.layer }),
  });
  if (!principal.grants.some((grant) => grantAllows(grant, next, layers)))
    return false;
  const actor = { userId: principal.principalId, roles: principal.roles };
  if (!evidence.schemas.every((schema) => auth.canRead(actor, path, schema)))
    return false;
  return authorize(token, next);
}

function readDecision(callback: () => unknown): boolean {
  try {
    const decision = callback();
    if (decision instanceof Promise)
      void Promise.prototype.then.call(decision, undefined, () => {});
    return authorizationDecisionSchema.safeParse(decision).data === "allowed";
  } catch {
    return false;
  }
}
