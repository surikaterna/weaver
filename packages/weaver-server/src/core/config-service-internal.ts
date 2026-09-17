import type { WriteResult } from "@weaver-conf/config-types";
import type { WeaverConfigService, WriteContext } from "./config-service-types";

interface InternalConfigAccess {
  readonly write: (
    layer: string,
    key: string,
    value: unknown,
    options?: WriteContext,
  ) => Promise<WriteResult>;
  readonly remove: (
    layer: string,
    key: string,
    options?: WriteContext,
  ) => Promise<WriteResult>;
}

const internalConfigAccess = new WeakMap<
  WeaverConfigService,
  InternalConfigAccess
>();

export function registerInternalConfigAccess(
  configService: WeaverConfigService,
  access: InternalConfigAccess,
): void {
  internalConfigAccess.set(configService, access);
}

export async function writeInternalConfig(
  configService: WeaverConfigService,
  layer: string,
  key: string,
  value: unknown,
  options?: WriteContext,
): Promise<WriteResult> {
  const access = internalConfigAccess.get(configService);
  if (!access) return missingInternalAccessResult();
  return access.write(layer, key, value, options);
}

export async function removeInternalConfig(
  configService: WeaverConfigService,
  layer: string,
  key: string,
  options?: WriteContext,
): Promise<WriteResult> {
  const access = internalConfigAccess.get(configService);
  if (!access) return missingInternalAccessResult();
  return access.remove(layer, key, options);
}

function missingInternalAccessResult(): WriteResult {
  return {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "Config service does not expose internal write access",
    },
  };
}
