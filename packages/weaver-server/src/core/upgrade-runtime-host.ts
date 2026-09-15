import type { BootstrapAdministrator } from "../bootstrap/seed-trust";
import type { WeaverConfigService } from "./config-service-types";

export interface UpgradeRuntimeHost {
  readonly configService: WeaverConfigService;
  readonly enterMaintenance: (
    administrator?: BootstrapAdministrator,
  ) => Promise<void>;
  readonly requireRestart: () => void;
}
