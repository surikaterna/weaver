import {
  createWeaverError,
  type OverrideSession,
  type SessionActivationRequest,
  type SessionDeactivationResult,
  type SessionDomainAuditEntry,
  sessionActivationRequestSchema,
} from "@weaver-conf/config-types";
import {
  type OverrideSessionController,
  type OverrideSessionProviderOptions,
  overrideSessionProviderOptionsSchema,
  type SessionExpiryIntent,
  type SessionTimer,
  sessionDurationSchema,
  sessionExpiryIntentSchema,
} from "./session-contracts";
import { SessionStorage } from "./session-storage";

type Metadata = Omit<OverrideSession, "overrides" | "isActive">;
const MAX_TIMEOUT_MS = 2147483647;
const nativeTimer: SessionTimer = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  clearTimeout(handle) {
    if (typeof handle === "function") handle();
  },
};

class SessionController implements OverrideSessionController {
  private session: Metadata | null = null;
  private readonly storage: SessionStorage;
  private readonly timer: SessionTimer;
  private timerId: unknown;
  private timerPending = false;
  private lease = 0;
  private wake = 0;
  private deadline = 0;
  private disposed = false;
  private currentDuration: number;

  constructor(private readonly options: OverrideSessionProviderOptions) {
    this.currentDuration = options.defaultDurationMs ?? 14400000;
    this.timer = options.timer ?? nativeTimer;
    this.storage = new SessionStorage(
      options.id ?? "override-session",
      options.layer ?? "session",
      () => this.isActive(),
    );
  }

  get provider() {
    return this.storage.provider;
  }

  private now(): number {
    try {
      const now = (this.options.now ?? Date.now)();
      return Number.isSafeInteger(now) && now >= 0 && now <= 8640000000000000
        ? now
        : Number.NaN;
    } catch {
      return Number.NaN;
    }
  }

  private expiry(duration: number): { now: number; deadline: number } {
    const parsed = sessionDurationSchema.safeParse(duration);
    const now = this.now();
    const deadline = Math.min(
      now + duration,
      Math.floor(this.options.expiresAtLimit ?? Infinity),
    );
    if (
      !parsed.success ||
      duration > (this.options.maxDurationMs ?? MAX_TIMEOUT_MS) ||
      !Number.isFinite(now) ||
      deadline > 8640000000000000 ||
      deadline <= now
    ) {
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Invalid session duration or clock",
      );
    }
    return { now, deadline };
  }

  activate(request: SessionActivationRequest): OverrideSession {
    if (this.disposed)
      throw createWeaverError("SESSION_BLOCKED", "Session controller disposed");
    if (this.session !== null)
      throw createWeaverError("SESSION_BLOCKED", "Session already active");
    const parsed = sessionActivationRequestSchema.safeParse(request);
    if (!parsed.success)
      throw createWeaverError("VALIDATION_ERROR", "Invalid session activation");
    const duration =
      parsed.data.durationMs ?? this.options.defaultDurationMs ?? 14400000;
    const { now, deadline } = this.expiry(duration);
    this.session = {
      id: crypto.randomUUID(),
      activatedAt: new Date(now).toISOString(),
      expiresAt: new Date(deadline).toISOString(),
      activatedBy: parsed.data.activatedBy ?? "system",
      reason: parsed.data.reason,
    };
    this.currentDuration = duration;
    this.deadline = deadline;
    this.lease++;
    this.startTimer();
    const snapshot = this.snapshot();
    this.audit(this.session, "activate", {
      reason: this.session.reason,
      durationMs: duration,
    });
    return snapshot;
  }

  extend(durationMs = this.currentDuration): OverrideSession {
    if (!this.isActive() || this.session === null)
      throw createWeaverError("SESSION_REQUIRED", "No active session");
    const { deadline } = this.expiry(durationMs);
    this.clearTimer();
    this.deadline = deadline;
    this.currentDuration = durationMs;
    this.lease++;
    this.session = {
      ...this.session,
      expiresAt: new Date(deadline).toISOString(),
    };
    this.startTimer();
    const snapshot = this.snapshot();
    this.audit(this.session, "extend", { durationMs });
    return snapshot;
  }

  isActive(): boolean {
    return (
      !this.disposed && this.session !== null && this.now() < this.deadline
    );
  }

  getSession(): OverrideSession | null {
    return this.session === null ? null : this.snapshot();
  }

  private snapshot(): OverrideSession {
    if (this.session === null)
      throw createWeaverError("SESSION_REQUIRED", "No active session");
    return {
      ...this.session,
      isActive: this.isActive(),
      overrides: this.storage.snapshot(),
    };
  }

  deactivate(): SessionDeactivationResult {
    if (this.session === null)
      throw createWeaverError("SESSION_REQUIRED", "No active session");
    return this.finish("deactivate");
  }

  private finish(action: "deactivate" | "expire"): SessionDeactivationResult {
    const session = this.session;
    if (session === null)
      throw createWeaverError("SESSION_REQUIRED", "No active session");
    this.clearTimer();
    const overridesCleared = this.storage.clear();
    this.session = null;
    this.lease++;
    const now = this.now();
    const deactivatedAt = new Date(
      Number.isFinite(now) ? now : this.deadline,
    ).toISOString();
    const auditRecorded = this.audit(
      session,
      action,
      { overridesCleared },
      deactivatedAt,
    );
    return {
      sessionId: session.id,
      deactivatedAt,
      overridesCleared,
      auditRecorded,
    };
  }

  commitExpiry(intent: SessionExpiryIntent): boolean {
    if (
      !sessionExpiryIntentSchema.safeParse(intent).success ||
      !this.matches(intent)
    )
      return false;
    if (this.now() < this.deadline) {
      if (!this.timerPending) this.startTimer();
      return false;
    }
    this.finish("expire");
    return true;
  }

  private matches(intent: SessionExpiryIntent): boolean {
    return (
      !this.disposed &&
      this.session?.id === intent.sessionId &&
      this.lease === intent.lease &&
      this.deadline === intent.expiresAt
    );
  }

  private clearTimer(): void {
    if (!this.timerPending) return;
    this.timerPending = false;
    this.wake++;
    this.timer.clearTimeout(this.timerId);
    this.timerId = undefined;
  }

  /** Stop wakeups before a host drains already accepted work; retain queued data. */
  cancelExpiry(): void {
    this.clearTimer();
  }

  private startTimer(): void {
    if (this.session === null) return;
    const intent = Object.freeze({
      sessionId: this.session.id,
      expiresAt: this.deadline,
      lease: this.lease,
    });
    const remaining = this.deadline - this.now();
    const wake = ++this.wake;
    this.timerPending = true;
    this.timerId = this.timer.setTimeout(
      () => this.timerFired(intent, wake),
      Number.isFinite(remaining)
        ? Math.min(MAX_TIMEOUT_MS, Math.max(0, remaining))
        : 0,
    );
  }

  private timerFired(intent: SessionExpiryIntent, wake: number): void {
    if (wake !== this.wake || !this.matches(intent)) return;
    this.wake++;
    this.timerPending = false;
    this.timerId = undefined;
    if (this.now() < this.deadline) {
      this.startTimer();
      return;
    }
    // Deadline ends eligibility immediately; a root queues the destructive transition.
    if (this.options.onExpiryRequested === undefined) this.commitExpiry(intent);
    else this.requestExpiry(intent);
  }

  private requestExpiry(intent: SessionExpiryIntent): void {
    try {
      const result: unknown = this.options.onExpiryRequested?.(intent);
      void Promise.resolve(result).catch(() => {});
    } catch {
      // A failed root callback cannot authorize new writes or clear queued data.
    }
  }

  private audit(
    session: Metadata,
    action: SessionDomainAuditEntry["action"],
    details: Record<string, unknown>,
    timestamp = session.activatedAt,
  ): boolean {
    if (this.options.onAudit === undefined) return false;
    try {
      const now = this.now();
      const result: unknown = this.options.onAudit({
        domain: "session",
        action,
        actor: session.activatedBy,
        sessionId: session.id,
        timestamp: Number.isFinite(now)
          ? new Date(now).toISOString()
          : timestamp,
        details,
      });
      void Promise.resolve(result).catch(() => {});
      return result === undefined;
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    if (this.session !== null) this.finish("deactivate");
  }
}

/** Trusted standalone storage domain, not a root authentication or mutation port. */
export function createOverrideSessionProvider(
  options?: OverrideSessionProviderOptions,
): OverrideSessionController {
  const parsed = overrideSessionProviderOptionsSchema.safeParse(options ?? {});
  if (!parsed.success)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Invalid session provider options",
    );
  return new SessionController(parsed.data);
}
