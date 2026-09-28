import type {
  SchemaRegistrationResponse,
  SchemaValidationResult,
} from "@weaver-conf/config-types";
import type { WriteResult } from "./transport";

export function unsupportedWrite(method: string): WriteResult {
  return {
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message: `Transport does not support ${method}`,
    },
  };
}

export function unsupportedRegistration(
  method: string,
): SchemaRegistrationResponse {
  return {
    success: false,
    isNewSchema: false,
    hasBreakingChanges: false,
    error: {
      code: "VALIDATION_ERROR",
      message: `Transport does not support ${method}`,
    },
  };
}

export function unsupportedValidation(method: string): SchemaValidationResult {
  return {
    valid: false,
    errors: [
      {
        code: "invalid-schema",
        path: "$",
        segments: [],
        message: `Transport does not support ${method}`,
      },
    ],
  };
}
