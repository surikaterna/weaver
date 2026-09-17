import { z } from "zod";
import { internalUpgradePlanRequestSchema } from "./internal-upgrade-planning";

export const upgradeApplyRequestSchema = z.strictObject({
  version: z.literal(1),
  request: internalUpgradePlanRequestSchema,
  runId: z.uuid().optional(),
});
export type UpgradeApplyRequest = z.infer<typeof upgradeApplyRequestSchema>;

export const upgradeRecoveryRequestSchema = z.strictObject({
  version: z.literal(1),
  runId: z.uuid(),
  action: z.enum(["resume", "compensate"]).default("resume"),
  priorOwnerStopped: z
    .strictObject({
      observedAt: z.iso.datetime(),
      evidence: z.string().min(1).max(2048),
    })
    .optional(),
});
export type UpgradeRecoveryRequest = z.infer<
  typeof upgradeRecoveryRequestSchema
>;

export const publicMaintenanceFailureCodeSchema = z.enum([
  "stale-plan",
  "conflict",
  "unknown-commit",
  "validation",
  "ownership",
  "storage",
  "operator-required",
  "internal",
]);
export type PublicMaintenanceFailureCode = z.infer<
  typeof publicMaintenanceFailureCodeSchema
>;

const publicFailureMessages = {
  "stale-plan": "Upgrade plan is no longer current",
  conflict: "Upgrade conflicts with current state",
  "unknown-commit": "Upgrade outcome is uncertain; operator action is required",
  validation: "Upgrade validation failed",
  ownership: "Upgrade ownership could not be established",
  storage: "Upgrade storage operation failed",
  "operator-required": "Upgrade requires operator action",
  internal: "Upgrade could not be completed",
} as const satisfies Record<PublicMaintenanceFailureCode, string>;

const publicMaintenanceFailureCategorySchema = z.enum([
  "conflict",
  "uncertainty",
  "validation",
  "ownership",
  "storage",
  "operator",
  "internal",
]);
export const publicMaintenanceFailureSchema = z
  .strictObject({
    code: publicMaintenanceFailureCodeSchema,
    category: publicMaintenanceFailureCategorySchema,
    message: z.enum(Object.values(publicFailureMessages)),
  })
  .superRefine((failure, context) => {
    if (
      failure.message !== publicFailureMessages[failure.code] ||
      failure.category !== failureCategory(failure.code)
    )
      context.addIssue({
        code: "custom",
        message: "Public maintenance failure fields do not match the code",
      });
  });
export type PublicMaintenanceFailure = z.infer<
  typeof publicMaintenanceFailureSchema
>;

const publicProviderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/);

export const publicUpgradeEffectsSchema = z.strictObject({
  partialEffects: z.boolean(),
  completedSteps: z.number().int().min(0).max(1000),
  pendingSteps: z.number().int().min(0).max(1000),
  quarantinedProviders: z.array(publicProviderIdSchema).max(100).readonly(),
});
export type PublicUpgradeEffects = z.infer<typeof publicUpgradeEffectsSchema>;

export const upgradeExecutionResultSchema = z.strictObject({
  version: z.literal(1),
  runId: z.uuid().optional(),
  status: z.enum(["completed", "restart-required", "blocked", "compensated"]),
  effects: publicUpgradeEffectsSchema,
  failure: publicMaintenanceFailureSchema.optional(),
});
export type UpgradeExecutionResult = z.infer<
  typeof upgradeExecutionResultSchema
>;

export const maintenanceStatusSchema = z.strictObject({
  version: z.literal(1),
  state: z.enum([
    "ready",
    "maintenance",
    "restart_required",
    "failed",
    "closed",
  ]),
  ready: z.boolean(),
  failure: publicMaintenanceFailureSchema.optional(),
  activeRun: z
    .strictObject({
      runId: z.uuid(),
      phase: z.enum([
        "prepared",
        "applying",
        "verifying",
        "completed",
        "blocked",
        "compensating",
        "compensated",
        "restart-required",
      ]),
      effects: publicUpgradeEffectsSchema,
      failure: publicMaintenanceFailureSchema.optional(),
    })
    .optional(),
});
export type MaintenanceStatus = z.infer<typeof maintenanceStatusSchema>;

export function publicMaintenanceFailure(
  code: PublicMaintenanceFailureCode,
): PublicMaintenanceFailure {
  return publicMaintenanceFailureSchema.parse({
    code,
    category: failureCategory(code),
    message: publicFailureMessages[code],
  });
}

function failureCategory(code: PublicMaintenanceFailureCode) {
  if (code === "stale-plan" || code === "conflict") return "conflict" as const;
  if (code === "unknown-commit") return "uncertainty" as const;
  if (code === "validation") return "validation" as const;
  if (code === "ownership") return "ownership" as const;
  if (code === "storage") return "storage" as const;
  if (code === "operator-required") return "operator" as const;
  return "internal" as const;
}
