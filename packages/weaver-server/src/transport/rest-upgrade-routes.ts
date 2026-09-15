import {
  createWeaverError,
  internalUpgradePlanRequestSchema,
  maintenanceStatusSchema,
  publicMaintenanceFailure,
  upgradeApplyRequestSchema,
  upgradeExecutionResultSchema,
  upgradeRecoveryRequestSchema,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import { ZodError } from "zod";
import { publicUpgradeFailure } from "../core/public-upgrade-status";
import type { WeaverRuntime } from "../server-runtime";
import { httpStatusForError } from "../types";
import type { RestResponse, RestRoute } from "./rest-adapter";
import { v1Response } from "./rest-helpers";

export function buildUpgradeRoutes(runtime?: WeaverRuntime): RestRoute[] {
  if (!runtime) return [];
  const admin = (request: { authContext?: { isAdmin: boolean } }) => {
    if (!request.authContext?.isAdmin)
      throw createWeaverError("FORBIDDEN", "Admin access required");
  };
  return [
    {
      method: "POST",
      path: "/v1/admin/upgrades/plan",
      maintenance: true,
      async handler(request) {
        admin(request);
        if (runtime.state !== "ready")
          throw createWeaverError(
            "MAINTENANCE",
            "Planning is unavailable during maintenance",
          );
        return v1Response(
          runtime.configService,
          200,
          await runtime.planUpgrade(
            internalUpgradePlanRequestSchema.parse(request.body),
          ),
        );
      },
    },
    {
      method: "POST",
      path: "/v1/admin/upgrades/apply",
      maintenance: true,
      async handler(request) {
        return executeUpgrade(async () => {
          admin(request);
          return runtime.applyUpgrade(
            upgradeApplyRequestSchema.parse(request.body),
          );
        });
      },
    },
    {
      method: "POST",
      path: "/v1/admin/upgrades/recover",
      maintenance: true,
      async handler(request) {
        return executeUpgrade(async () => {
          admin(request);
          return runtime.recoverUpgrade(
            upgradeRecoveryRequestSchema.parse(request.body),
          );
        });
      },
    },
    {
      method: "GET",
      path: "/v1/admin/upgrades/status",
      maintenance: true,
      async handler(request) {
        return executeStatus(() => {
          admin(request);
          return runtime.maintenanceStatus();
        });
      },
    },
  ];
}

async function executeUpgrade(
  execute: () => Promise<unknown>,
): Promise<RestResponse> {
  try {
    const result = upgradeExecutionResultSchema.safeParse(await execute());
    return result.success
      ? upgradeResponse(200, result.data)
      : publicErrorResponse(500, "INTERNAL_ERROR", "internal");
  } catch (error) {
    return upgradeErrorResponse(error);
  }
}

function executeStatus(execute: () => unknown): RestResponse {
  try {
    const status = maintenanceStatusSchema.safeParse(execute());
    return status.success
      ? upgradeResponse(200, status.data)
      : publicErrorResponse(500, "INTERNAL_ERROR", "internal");
  } catch (error) {
    return upgradeErrorResponse(error);
  }
}

function upgradeResponse(status: number, body: unknown): RestResponse {
  return {
    status,
    body: { data: body },
    headers: { "Content-Type": "application/json" },
  };
}

function upgradeErrorResponse(error: unknown): RestResponse {
  if (error instanceof ZodError)
    return publicErrorResponse(400, "VALIDATION_ERROR", "validation");
  if (error instanceof WeaverErrorInstance)
    return publicErrorResponse(
      httpStatusForError(error.code),
      error.code,
      publicUpgradeFailure(error).code,
    );
  return publicErrorResponse(500, "INTERNAL_ERROR", "internal");
}

function publicErrorResponse(
  status: number,
  code: string,
  failureCode: Parameters<typeof publicMaintenanceFailure>[0],
): RestResponse {
  const failure = publicMaintenanceFailure(failureCode);
  return {
    status,
    body: { data: null, error: { code, message: failure.message } },
    headers: { "Content-Type": "application/json" },
  };
}
