import { createWeaverError } from "@weaver-conf/config-types";
import type { ApplicationMaintenanceBarrier } from "./application-maintenance-barrier";
import type { WeaverConfigService } from "./config-service-types";

interface LifecycleBinding {
  readonly barrier: ApplicationMaintenanceBarrier;
  readonly revision: () => string;
  readonly listeners: Set<ConfigServiceLifecycleListener>;
  generation: number;
  state: ConfigServiceLifecycleState;
}

export interface ConfigServiceLifecycleEvent {
  readonly generation: number;
  readonly state: ConfigServiceLifecycleState;
}

type ConfigServiceLifecycleState = "open" | "suspended";
type ConfigServiceLifecycleListener = (
  event: ConfigServiceLifecycleEvent,
) => void;

const bindings = new WeakMap<WeaverConfigService, LifecycleBinding>();

export function bindConfigServiceLifecycle(
  service: WeaverConfigService,
  barrier: ApplicationMaintenanceBarrier,
  revision: () => string,
): void {
  bindings.set(service, {
    barrier,
    revision,
    listeners: new Set(),
    generation: 0,
    state: barrier.state() === "open" ? "open" : "suspended",
  });
}

export function subscribeConfigServiceLifecycle(
  service: WeaverConfigService,
  listener: ConfigServiceLifecycleListener,
):
  | {
      readonly current: ConfigServiceLifecycleEvent;
      readonly unsubscribe: () => void;
    }
  | undefined {
  const binding = bindings.get(service);
  if (!binding) return undefined;
  binding.listeners.add(listener);
  return {
    current: currentEvent(binding),
    unsubscribe: () => binding.listeners.delete(listener),
  };
}

export function subscribeConfigServiceMaintenance(
  service: WeaverConfigService,
  listener: () => void,
): (() => void) | undefined {
  let unsubscribe = () => {};
  const subscription = subscribeConfigServiceLifecycle(service, (event) => {
    if (event.state !== "suspended") return;
    unsubscribe();
    listener();
  });
  if (!subscription) return undefined;
  unsubscribe = subscription.unsubscribe;
  if (subscription.current.state === "suspended") {
    unsubscribe();
    listener();
  }
  return unsubscribe;
}

export function assertConfigServiceTransportOpen(
  service: WeaverConfigService,
): void {
  bindings.get(service)?.barrier.assertApplicationAccess();
}

export function configServiceTransportRevision(
  service: WeaverConfigService,
): string {
  return bindings.get(service)?.revision() ?? service.revision;
}

export function notifyConfigServiceMaintenance(
  service: WeaverConfigService,
): void {
  const binding = bindings.get(service);
  if (!binding) return;
  if (binding.state === "suspended") return;
  binding.generation++;
  binding.state = "suspended";
  notifyListeners(binding);
}

export function notifyConfigServiceResume(service: WeaverConfigService): void {
  const binding = bindings.get(service);
  if (!binding || binding.state === "open") return;
  if (binding.barrier.state() !== "open")
    throw createWeaverError("MAINTENANCE", "Application admission is not open");
  binding.state = "open";
  notifyListeners(binding);
}

function currentEvent(binding: LifecycleBinding): ConfigServiceLifecycleEvent {
  return { generation: binding.generation, state: binding.state };
}

function notifyListeners(binding: LifecycleBinding): void {
  const event = currentEvent(binding);
  let failed = false;
  for (const listener of [...binding.listeners]) {
    try {
      listener(event);
    } catch {
      failed = true;
    }
  }
  if (failed)
    throw createWeaverError(
      "MAINTENANCE",
      "Application lifecycle notification failed",
    );
}
