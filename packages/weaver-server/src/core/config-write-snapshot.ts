import type { WriteResult } from "@weaver-conf/config-types";

export function snapshotSubmitted<T>(
  value: T,
):
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly result: WriteResult } {
  try {
    return { success: true, value: structuredClone(value) };
  } catch {
    return {
      success: false,
      result: {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Configuration input cannot be cloned",
        },
      },
    };
  }
}
