import { createWeaverError } from "@weaver-conf/config-types";
import type { ConfigServiceController } from "./config-service-controller";
import type { WeaverConfigService } from "./config-service-types";

const hosts = new WeakMap<WeaverConfigService, ConfigServiceController>();

export function bindControlHost(
  service: WeaverConfigService,
  host: ConfigServiceController,
): void {
  if (hosts.has(service))
    throw createWeaverError("FORBIDDEN", "Control host is already bound");
  hosts.set(service, host);
}

export function hostForControl(
  service: WeaverConfigService,
): ConfigServiceController {
  const host = hosts.get(service);
  if (!host)
    throw createWeaverError(
      "FORBIDDEN",
      "No control capability for this service",
    );
  return host;
}
