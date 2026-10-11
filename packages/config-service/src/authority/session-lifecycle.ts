import {
  createOverrideSessionProvider,
  type SessionExpiryIntent,
} from "@weaver-conf/config-sessions";
import {
  type ConfigurationSessionActivation,
  type ConfigurationSessionDeactivation,
  type ConfigurationSessionInfo,
  configurationSessionDeactivationSchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import { hydrateIdentity } from "../identity-hydration";
import type { RootState } from "../root-state";
import { auditWrite } from "./authority-audit";
import { publish } from "./publication";
import {
  authorizeSession,
  checkSessionAccess,
  declareSessionTarget,
  type SessionAccess,
  sessionRequest,
} from "./session-access";
import {
  bindSession,
  type SessionReference,
  type SessionRemovalCause,
  sessionInfo,
  sessionMetadata,
} from "./session-bindings";
import { stageSession } from "./session-publication";

export function sessionLayer(state: RootState) {
  const rank = state.factory.options.layers.findIndex(
    (slot) => slot.kind === "session",
  );
  const slot = state.factory.options.layers[rank];
  if (!slot || !state.factory.host.sessions)
    throw createWeaverError(
      "UNSUPPORTED_OPERATION",
      "Sessions are not configured",
    );
  return { layer: slot.layer, rank, limits: state.factory.host.sessions };
}
export function assertSessionWritable(state: RootState): void {
  if (state.writeFence || state.schemaFence)
    throw createWeaverError("WRITE_UNAVAILABLE", "Session changes are fenced");
}

function durationFor(access: SessionAccess, requested?: number): number {
  const { limits } = sessionLayer(access.state);
  const duration = requested ?? limits.defaultDurationMs;
  const now = (access.state.factory.host.now ?? Date.now)();
  const creator = access.principal;
  const capped = Math.min(
    duration,
    Math.floor((creator.expiresAt ?? Infinity) - now),
  );
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(capped) ||
    capped <= 0 ||
    duration > limits.maxDurationMs
  )
    throw createWeaverError("VALIDATION_ERROR", "Invalid session duration");
  return capped;
}

export async function activateSession(
  access: SessionAccess,
  request: ConfigurationSessionActivation,
): Promise<ConfigurationSessionInfo> {
  const { state } = access;
  assertSessionWritable(state);
  const { layer, limits } = sessionLayer(state);
  assertSessionCapacity(state, limits.maxActiveSessions);
  durationFor(access, request.durationMs);
  const authorization = sessionRequest(request, layer, "session-activate");
  await authorizeSession(access, authorization);
  const guard = () => checkSessionAccess(access, authorization);
  await hydrateIdentity(state, request.identity, new Set([guard]));
  guard();
  declareSessionTarget(state, request);
  const duration = durationFor(access, request.durationMs);
  const ref = createSessionReference(access, request, duration);
  let info: ConfigurationSessionInfo;
  try {
    const plan = stageSession(state, ref, true);
    guard();
    info = requireSessionInfo(ref);
    state.sessions.set(info.id, ref);
    publish(state, plan, "session");
  } catch (error) {
    ref.controller.dispose();
    throw error;
  }
  await auditWrite(
    state,
    {
      principal: access.principal,
      request: { ...authorization, sessionId: info.id },
    },
    "committed",
  );
  return info;
}

function assertSessionCapacity(state: RootState, maximum: number): void {
  const active = [...state.sessions.values()].filter((ref) =>
    ref.controller.isActive(),
  );
  if (active.length >= maximum)
    throw createWeaverError("SESSION_BLOCKED", "Session limit reached");
}

function newProviderId(state: RootState): string {
  const providerId = `${state.incarnation}session:${crypto.randomUUID()}`;
  if (
    state.factory.captured.some(
      (binding) => binding.binding.id === providerId,
    ) ||
    [...state.sessions.values()].some(
      (ref) => ref.selection.captured.binding.id === providerId,
    )
  )
    throw createWeaverError(
      "INTERNAL_ERROR",
      "Session provider identity collision",
    );
  return providerId;
}

function createSessionReference(
  access: SessionAccess,
  request: ConfigurationSessionActivation,
  duration: number,
): SessionReference {
  const { state } = access;
  const { layer, rank, limits } = sessionLayer(state);
  const controller = createOverrideSessionProvider({
    id: newProviderId(state),
    layer,
    defaultDurationMs: duration,
    maxDurationMs: limits.maxDurationMs,
    expiresAtLimit: access.principal.expiresAt,
    now: state.factory.host.now ?? Date.now,
    timer: limits.timer,
    onExpiryRequested: (intent) => requestSessionExpiry(state, intent),
  });
  try {
    const metadata = controller.activate({
      reason: request.reason,
      activatedBy: access.principal.principalId,
      durationMs: duration,
    });
    if (state.sessions.has(metadata.id))
      throw createWeaverError("INTERNAL_ERROR", "Session identity collision");
    const target = {
      identity: request.identity,
      namespace: request.namespace,
      ...(request.viewId === undefined ? {} : { viewId: request.viewId }),
    };
    return Object.freeze({
      controller,
      target,
      owner: access.token,
      ownerCheck: () => {
        access.registry.current(access.token);
      },
      emergency: request.emergency,
      auditRemoval: (
        info: ConfigurationSessionInfo,
        cause: SessionRemovalCause,
      ) => auditRemoval(access, info, cause),
      ...bindSession(controller, target, rank),
    });
  } catch (error) {
    controller.dispose();
    throw error;
  }
}

function auditRemoval(
  access: SessionAccess,
  info: ConfigurationSessionInfo,
  cause: SessionRemovalCause,
): Promise<void> {
  return auditWrite(
    access.state,
    {
      principal: access.principal,
      request: sessionRequest(info, info.layer, "session-deactivate", cause),
    },
    "committed",
  );
}

export function requireSessionInfo(
  ref: SessionReference,
): ConfigurationSessionInfo {
  ref.ownerCheck();
  const info = sessionInfo(ref);
  if (!info) throw createWeaverError("FORBIDDEN", "Session unavailable");
  return info;
}

export async function extendSession(
  access: SessionAccess,
  ref: SessionReference,
  durationMs?: number,
): Promise<ConfigurationSessionInfo> {
  assertSessionWritable(access.state);
  const info = requireSessionInfo(ref);
  const request = {
    ...sessionRequest(info, info.layer, "session-extend"),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
  await authorizeSession(access, request, ref);
  requireSessionInfo(ref);
  ref.controller.extend(durationMs);
  const extended = requireSessionInfo(ref);
  await auditWrite(
    access.state,
    { principal: access.principal, request },
    "committed",
  );
  return extended;
}

export function removeSession(
  state: RootState,
  ref: SessionReference,
  intent?: SessionExpiryIntent,
  cause?: SessionRemovalCause,
): ConfigurationSessionDeactivation | null {
  const meta = ref.controller.getSession();
  const info = sessionMetadata(ref);
  if (
    !meta ||
    (intent &&
      (meta.id !== intent.sessionId ||
        Date.parse(meta.expiresAt) !== intent.expiresAt))
  )
    return null;
  const plan = state.schemaFence ? undefined : stageSession(state, ref, false);
  let result: ConfigurationSessionDeactivation;
  if (intent) {
    const count = Object.keys(meta.overrides).length;
    if (!ref.controller.commitExpiry(intent)) return null;
    result = {
      sessionId: meta.id,
      overridesCleared: count,
      deactivatedAt: cleanupTime(state, intent.expiresAt),
    };
  } else {
    const removed = ref.controller.deactivate();
    result = {
      sessionId: removed.sessionId,
      overridesCleared: removed.overridesCleared,
      deactivatedAt: Date.parse(removed.deactivatedAt),
    };
  }
  ref.controller.dispose();
  state.sessions.delete(meta.id);
  if (plan) publish(state, plan, "session");
  if (cause && info) void ref.auditRemoval(info, cause);
  return configurationSessionDeactivationSchema.parse(result);
}

function cleanupTime(state: RootState, fallback: number): number {
  try {
    const now = (state.factory.host.now ?? Date.now)();
    return Number.isSafeInteger(now) && now >= 0 ? now : fallback;
  } catch {
    return fallback;
  }
}

function requestSessionExpiry(
  state: RootState,
  intent: SessionExpiryIntent,
): void {
  void state.queue
    .enqueue(() => {
      if (state.disposed) return;
      const ref = state.sessions.get(intent.sessionId);
      if (ref) removeSession(state, ref, intent, "expired");
    })
    .catch(() => {});
}

export function revokeSessions(state: RootState, owner: unknown): void {
  for (const ref of state.sessions.values()) {
    if (ref.owner !== owner) continue;
    void state.queue
      .enqueue(() => {
        if (!state.disposed) removeSession(state, ref, undefined, "revoked");
      })
      .catch(() => {});
  }
}

export function stopSessionTimers(state: RootState): void {
  for (const ref of state.sessions.values()) ref.controller.cancelExpiry();
}
export function disposeSessions(state: RootState): void {
  for (const ref of state.sessions.values()) {
    const info = sessionMetadata(ref);
    ref.controller.dispose();
    if (info)
      void ref.auditRemoval(
        info,
        state.schemaFence ? "schema-fenced" : "disposed",
      );
  }
  state.sessions.clear();
}
