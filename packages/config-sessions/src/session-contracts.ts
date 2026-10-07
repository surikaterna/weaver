import type {
  ConfigurationStorageProvider,
  OverrideSession,
  SessionActivationRequest,
  SessionDeactivationResult,
  SessionDomainAuditEntry,
} from "@weaver-conf/config-types";
import { z } from "zod";

export const sessionDurationSchema = z
  .number()
  .int()
  .positive()
  .max(2147483647);
export const sessionExpiryIntentSchema = z
  .strictObject({
    sessionId: z.string().uuid(),
    expiresAt: z.number().int().nonnegative(),
    lease: z.number().int().positive(),
  })
  .readonly();
export type SessionExpiryIntent = z.infer<typeof sessionExpiryIntentSchema>;

export interface SessionTimer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const sessionTimerSchema = z.custom<SessionTimer>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    "setTimeout" in value &&
    typeof value.setTimeout === "function" &&
    "clearTimeout" in value &&
    typeof value.clearTimeout === "function",
);

export const overrideSessionProviderOptionsSchema = z
  .strictObject({
    layer: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    defaultDurationMs: sessionDurationSchema.optional(),
    maxDurationMs: sessionDurationSchema.optional(),
    expiresAtLimit: z.number().finite().nonnegative().optional(),
    now: z
      .custom<() => number>((value) => typeof value === "function")
      .optional(),
    timer: sessionTimerSchema.optional(),
    onAudit: z
      .custom<(entry: SessionDomainAuditEntry) => void>(
        (value) => typeof value === "function",
      )
      .optional(),
    onExpiryRequested: z
      .custom<(intent: SessionExpiryIntent) => void>(
        (value) => typeof value === "function",
      )
      .optional(),
  })
  .refine(
    (options) =>
      (options.defaultDurationMs ?? 14400000) <=
      (options.maxDurationMs ?? 2147483647),
    "Default duration exceeds maximum",
  );
export type OverrideSessionProviderOptions = z.infer<
  typeof overrideSessionProviderOptionsSchema
>;

export interface OverrideSessionController {
  activate(request: SessionActivationRequest): OverrideSession;
  deactivate(): SessionDeactivationResult;
  extend(durationMs?: number): OverrideSession;
  getSession(): OverrideSession | null;
  isActive(): boolean;
  commitExpiry(intent: SessionExpiryIntent): boolean;
  cancelExpiry(): void;
  readonly provider: ConfigurationStorageProvider;
  dispose(): void;
}

export const overrideSessionControllerSchema =
  z.custom<OverrideSessionController>((value) => {
    if (value === null || typeof value !== "object") return false;
    const methods = [
      "activate",
      "deactivate",
      "extend",
      "getSession",
      "isActive",
      "commitExpiry",
      "cancelExpiry",
      "dispose",
    ];
    return (
      methods.every((name) => typeof Reflect.get(value, name) === "function") &&
      "provider" in value &&
      value.provider !== null &&
      typeof value.provider === "object"
    );
  });
