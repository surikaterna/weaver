/** Session type identifier (e.g., "emergency-override", "debug"). */
export type SessionType = string;

/** Whether a property allows, restricts, or blocks session overrides. */
export type PropertySessionMode = "allowed" | "restricted" | "blocked";

/** Metadata recorded when a session layer is activated. */
export interface SessionLayerMetadata {
  activatedBy: string;
  activatedAt: number;
  reason: string;
  mode: SessionType;
  expiresAt?: number | undefined;
}

/** Runtime session layer that holds temporary key overrides. */
export interface SessionLayer {
  readonly overrides: ReadonlyMap<string, unknown>;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  clear(): void;
  readonly active: boolean;
  readonly metadata: SessionLayerMetadata | null;
}

/** Serializable representation of an active override session. */
export interface OverrideSession {
  id: string;
  activatedAt: string;
  expiresAt: string;
  activatedBy: string;
  reason: string;
  isActive: boolean;
  overrides: Record<string, unknown>;
}

/** Request payload to activate a new override session. */
export interface SessionActivationRequest {
  reason: string;
  durationMs?: number | undefined;
  activatedBy?: string | undefined;
}

/** Result of deactivating a session — includes cleanup summary. */
export interface SessionDeactivationResult {
  sessionId: string;
  deactivatedAt: string;
  overridesCleared: number;
  auditRecorded: boolean;
}
