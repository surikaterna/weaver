import type { ConfigServiceController } from "./config-service-controller";
import { hostForControl } from "./config-service-host";
import type { WeaverConfigService } from "./config-service-types";

export function suspendControlApplication(
  service: WeaverConfigService,
  onRequested?: () => void,
): Promise<void> {
  const host = hostForControl(service);
  host.assertReady(true);
  return host.maintenance.enter(onRequested);
}

export function runMaintenanceOperation<T>(
  service: WeaverConfigService,
  operation: (host: ConfigServiceController) => Promise<T>,
): Promise<T> {
  const host = hostForControl(service);
  return host.coordinator.runControl(async () => {
    host.assertReady(true);
    return operation(host);
  });
}
