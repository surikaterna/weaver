import { hostForControl } from "../src/core/config-service-internal.ts";

export function rawRuntimeProviders(runtime) {
  return hostForControl(runtime.configService).providers;
}
