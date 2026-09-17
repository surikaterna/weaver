import { createWeaverError } from "@weaver-conf/config-types";
import { hostForControl } from "./config-service-host";
import type { WeaverConfigService } from "./config-service-types";

export type ApplicationConfigurationAvailability =
  | "preactivation"
  | "active"
  | "suspended";

export function applicationConfigurationAvailability(
  service: WeaverConfigService,
): ApplicationConfigurationAvailability {
  const host = hostForControl(service);
  if (host.applicationActive) return "active";
  return host.applicationError === "CONFIG_NOT_READY"
    ? "preactivation"
    : "suspended";
}

export function schemaRegistryTransactionMode(
  service: WeaverConfigService,
): "application" | "draft-control" {
  const host = hostForControl(service);
  host.coordinator.assertApplicationAccess();
  const availability = applicationConfigurationAvailability(service);
  if (availability === "active") return "application";
  if (
    availability === "preactivation" &&
    host.options.serviceMode === "control"
  )
    return "draft-control";
  host.assertReady();
  throw createWeaverError(
    "INTERNAL_ERROR",
    "Application availability is inconsistent",
  );
}

export function applicationAdmission(service: WeaverConfigService): boolean {
  return hostForControl(service).applicationActive;
}

export function assertApplicationAdmission(service: WeaverConfigService): void {
  assertHostApplicationAdmission(hostForControl(service));
}

export function applicationProjection(service: WeaverConfigService) {
  const host = hostForControl(service);
  assertHostApplicationAdmission(host);
  host.assertReady();
  return controlProjection(service);
}

function assertHostApplicationAdmission(
  host: ReturnType<typeof hostForControl>,
): void {
  const lease = host.batchContext.current();
  if (lease) host.coordinator.assertBatchLease(lease);
  else host.coordinator.assertApplicationAccess();
}

export function controlProjection(service: WeaverConfigService) {
  const host = hostForControl(service);
  host.assertReady(true);
  const contracts = host.pipeline.contracts;
  return Object.freeze({
    binding: Object.freeze({ ...contracts.binding }),
    prepared: () => ({
      configuration: structuredClone(contracts.prepared().configuration),
    }),
    registrations: () => structuredClone(contracts.registrations()),
  });
}
