import {
  type ConfigurationServiceProviderBinding,
  createWeaverError,
  type Result,
  type WeaverError,
  type WeaverErrorCode,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";

export interface Resource {
  readonly id: string;
  readonly close: () => void | Promise<void>;
}
export function errorData(
  code: WeaverErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Readonly<WeaverError> {
  return Object.freeze({
    code,
    message,
    ...(details ? { details: Object.freeze({ ...details }) } : {}),
  });
}
export async function closeResources(
  resources: readonly Resource[],
): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const resource of resources) {
    try {
      await resource.close();
    } catch {
      failed.push(resource.id);
    }
  }
  return Object.freeze(failed);
}
export function ownProviders(
  bindings: readonly ConfigurationServiceProviderBinding[],
): readonly Resource[] {
  const hooks = new Set<() => void | Promise<void>>();
  const resources: Resource[] = [];
  for (const binding of bindings) {
    if (
      binding.ownership.kind !== "owned" ||
      hooks.has(binding.ownership.dispose)
    )
      continue;
    const close = binding.ownership.dispose;
    hooks.add(close);
    resources.push({ id: binding.id, close });
  }
  return resources;
}
export function cleanupResult(
  failed: readonly string[],
): Result<undefined, WeaverError> {
  return failed.length
    ? {
        ok: false,
        error: errorData("INTERNAL_ERROR", "Resource cleanup failed", {
          cleanupFailedResources: failed,
        }),
      }
    : { ok: true, value: undefined };
}
export function initializationError(
  primary: unknown,
  cleanup: readonly string[],
): unknown {
  if (!cleanup.length) return primary;
  if (primary instanceof WeaverErrorInstance)
    return createWeaverError(primary.code, primary.message, {
      ...primary.details,
      cleanupFailedResources: cleanup,
    });
  return createWeaverError(
    "SERVER_DEGRADED",
    "Configuration initialization failed",
    { cleanupFailedResources: cleanup },
  );
}
