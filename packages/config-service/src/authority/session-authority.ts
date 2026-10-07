import type { AuthFunctions } from "@weaver-conf/config-auth";
import {
  authorizationDecisionSchema,
  type ConfigurationSessionAuthority,
  type ConfigurationSessionInfo,
  configurationSessionActivationSchema,
  configurationSessionExtensionSchema,
  configurationSessionSelectionSchema,
  createWeaverError,
  type Result,
  type WeaverError,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import type { RootState } from "../root-state";
import { auditWrite, invokeWriteHook } from "./authority-audit";
import {
  type createCapabilityRegistry,
  forbidden,
} from "./capability-registry";
import {
  authorizeSession,
  checkSessionAccess,
  type SessionAccess,
  sessionRequest,
} from "./session-access";
import { type SessionReference, sessionInfo } from "./session-bindings";
import {
  activateSession,
  extendSession,
  removeSession,
  requireSessionInfo,
  sessionLayer,
} from "./session-lifecycle";

export function createSessionAuthority(
  state: RootState,
  registry: ReturnType<typeof createCapabilityRegistry>,
  token: unknown,
  auth: AuthFunctions,
): ConfigurationSessionAuthority {
  const principal = registry.current(token).snapshot;
  const access = { state, registry, token, principal, auth };
  return Object.freeze<ConfigurationSessionAuthority>({
    activate: (input) =>
      operation(access, () => prepareActivation(access, input)),
    extend: (input) => operation(access, () => prepareExtension(access, input)),
    deactivate: (input) =>
      operation(access, () => prepareDeactivation(access, input)),
    get: (id) => {
      registry.current(token);
      const info = visibleSession(access, state.sessions.get(id));
      registry.current(token);
      return info;
    },
    list: () => listMetadata(access),
  });
}

function listMetadata(
  access: SessionAccess,
): readonly ConfigurationSessionInfo[] {
  access.registry.current(access.token);
  const admitted = [...access.state.sessions.values()].filter(
    (ref) => visibleSession(access, ref) !== null,
  );
  const values = admitted.flatMap((ref) => {
    try {
      return [requireSessionInfo(ref)];
    } catch {
      return [];
    }
  });
  access.registry.current(access.token);
  return Object.freeze(values);
}

function prepareActivation(access: SessionAccess, input: unknown) {
  const parsed = configurationSessionActivationSchema.safeParse(input);
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid session activation");
  const { layer } = sessionLayer(access.state);
  checkSessionAccess(
    access,
    sessionRequest(parsed.data, layer, "session-activate"),
  );
  return () => activateSession(access, parsed.data);
}

function prepareExtension(access: SessionAccess, input: unknown) {
  const parsed = configurationSessionExtensionSchema.safeParse(input);
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid session extension");
  const ref = ownedSession(access, parsed.data.sessionId, "session-extend");
  return () => extendSession(access, ref, parsed.data.durationMs);
}

function prepareDeactivation(access: SessionAccess, input: unknown) {
  const parsed = configurationSessionSelectionSchema.safeParse(input);
  if (!parsed.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid session selection");
  const ref = ownedSession(access, parsed.data.sessionId, "session-deactivate");
  return () => deactivateSession(access, ref);
}

async function operation<T>(
  access: SessionAccess,
  prepare: () => () => Promise<T>,
): Promise<Result<T, WeaverError>> {
  try {
    access.registry.current(access.token);
    if (access.state.writeHookActive) forbidden();
    const execute = prepare();
    return { ok: true, value: await access.state.queue.enqueue(execute) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof WeaverErrorInstance
          ? error
          : createWeaverError("INTERNAL_ERROR", "Session operation failed"),
    };
  }
}

function ownedSession(
  access: SessionAccess,
  id: string,
  operation: "session-extend" | "session-deactivate",
): SessionReference {
  const ref = access.state.sessions.get(id);
  if (!ref) return forbidden();
  const info = requireSessionInfo(ref);
  checkSessionAccess(access, sessionRequest(info, info.layer, operation), ref);
  return ref;
}

function visibleSession(
  access: SessionAccess,
  ref?: SessionReference,
): ConfigurationSessionInfo | null {
  if (!ref) return null;
  try {
    ref.ownerCheck();
    const info = sessionInfo(ref);
    if (!info) return null;
    const request = sessionRequest(info, info.layer, "session-read");
    checkSessionAccess(access, request, ref);
    const decision: unknown = invokeWriteHook(access.state, () =>
      access.state.factory.host.hostAuthority.authorizeReadSync(
        access.principal,
        request,
      ),
    );
    if (decision instanceof Promise)
      void Promise.prototype.then.call(decision, undefined, () => {});
    checkSessionAccess(access, request, ref);
    ref.ownerCheck();
    return authorizationDecisionSchema.safeParse(decision).data === "allowed" &&
      ref.controller.isActive()
      ? info
      : null;
  } catch {
    return null;
  }
}

async function deactivateSession(access: SessionAccess, ref: SessionReference) {
  const info = requireSessionInfo(ref);
  const request = sessionRequest(
    info,
    info.layer,
    "session-deactivate",
    "manual",
  );
  await authorizeSession(access, request, ref);
  const result = removeSession(access.state, ref);
  if (!result) return forbidden();
  await auditWrite(
    access.state,
    { principal: access.principal, request },
    "committed",
  );
  return result;
}
