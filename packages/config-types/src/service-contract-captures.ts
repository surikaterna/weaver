import {
  appendDomainValue,
  captureDomain,
  type DomainCapture,
  hasDomainFields,
  isDenseDomainArray,
  isDomainNonempty,
  isDomainRecord,
  isDomainString,
  ownDomainValue,
} from "./domain-capture";
import {
  isCanonicalConfigurationPath,
  isRegistrationEnvironment,
} from "./domain-paths";
import { type WeaverError, weaverErrorCodes } from "./errors";
import { isScopeInstanceData } from "./schemas-layers";
import type {
  ConfigurationEffectiveChange,
  ConfigurationInspectionValue,
  ConfigurationLayerContribution,
  ConfigurationServiceIdentity,
  ConfigurationServiceWriteOptions,
  ConfigurationServiceWriteResult,
  HydratedConfigurationInspection,
} from "./service-capabilities";
import { captureServiceData } from "./service-data-boundary";

export function captureServiceContract<T>(
  input: unknown,
  guard: (value: unknown) => value is T,
): DomainCapture<T> {
  const captured = captureServiceData(input);
  return captured.success ? captureDomain(captured.value, guard) : captured;
}

export function isConfigurationServiceIdentity(
  value: unknown,
): value is ConfigurationServiceIdentity {
  if (
    !isDomainRecord(value) ||
    !hasDomainFields(value, ["environment", "scopePath"])
  )
    return false;
  const scopes = ownDomainValue(value, "scopePath");
  if (
    !isRegistrationEnvironment(ownDomainValue(value, "environment")) ||
    !isDenseDomainArray(scopes, isScopeInstanceData)
  )
    return false;
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (seen.has(scope.scopeId)) return false;
    seen.add(scope.scopeId);
  }
  return true;
}

export function captureConfigurationServiceIdentity(
  input: unknown,
): DomainCapture<ConfigurationServiceIdentity> {
  return captureServiceContract(input, isConfigurationServiceIdentity);
}

export function isConfigurationInspectionValue(
  value: unknown,
): value is ConfigurationInspectionValue {
  if (!isDomainRecord(value)) return false;
  const state = ownDomainValue(value, "state");
  if (state === "missing" || state === "redacted")
    return hasDomainFields(value, ["state"]);
  return (
    state === "value" &&
    hasDomainFields(value, ["state", "value"]) &&
    ownDomainValue(value, "value") !== undefined
  );
}

export function isConfigurationLayerContribution(
  value: unknown,
): value is ConfigurationLayerContribution {
  if (!isDomainRecord(value)) return false;
  const state = ownDomainValue(value, "state");
  const fields =
    state === "value"
      ? ["state", "layer", "providerId", "value"]
      : ["state", "layer", "providerId"];
  if (
    !hasDomainFields(value, fields) ||
    !isDomainNonempty(value.layer) ||
    !isDomainNonempty(value.providerId)
  )
    return false;
  return (
    state === "missing" ||
    state === "redacted" ||
    (state === "value" && value.value !== undefined)
  );
}

function serviceProvenance(value: Record<string, unknown>): boolean {
  return (
    isCanonicalConfigurationPath(value.path) &&
    isConfigurationServiceIdentity(value.identity) &&
    isDomainNonempty(value.revision)
  );
}

export function isHydratedConfigurationInspection(
  value: unknown,
): value is HydratedConfigurationInspection {
  if (
    !isDomainRecord(value) ||
    !hasDomainFields(
      value,
      ["path", "identity", "revision", "effective", "contributions"],
      ["effectiveLayer"],
    )
  )
    return false;
  if (
    !serviceProvenance(value) ||
    !isConfigurationInspectionValue(value.effective) ||
    !isDenseDomainArray(value.contributions, isConfigurationLayerContribution)
  )
    return false;
  const effectiveLayer = ownDomainValue(value, "effectiveLayer");
  if (
    effectiveLayer !== undefined &&
    (!isDomainNonempty(effectiveLayer) || value.effective.state === "missing")
  )
    return false;
  const pairs = new Map<string, Set<string>>();
  for (const row of value.contributions) {
    let providers = pairs.get(row.layer);
    if (!providers) {
      providers = new Set();
      pairs.set(row.layer, providers);
    }
    if (providers.has(row.providerId)) return false;
    providers.add(row.providerId);
  }
  return true;
}

export function isConfigurationEffectiveChange(
  value: unknown,
): value is ConfigurationEffectiveChange {
  return (
    isDomainRecord(value) &&
    hasDomainFields(value, [
      "path",
      "identity",
      "revision",
      "previous",
      "current",
      "cause",
      "reloadBehavior",
    ]) &&
    serviceProvenance(value) &&
    isConfigurationInspectionValue(value.previous) &&
    isConfigurationInspectionValue(value.current) &&
    ["write", "remove", "reload", "external", "session"].includes(
      stringPrimitive(value.cause),
    ) &&
    ["hot", "restart-required", "rolling-restart"].includes(
      stringPrimitive(value.reloadBehavior),
    )
  );
}

function stringPrimitive(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isConfigurationServiceWriteOptions(
  value: unknown,
): value is ConfigurationServiceWriteOptions {
  return (
    isDomainRecord(value) &&
    hasDomainFields(value, ["layer"], ["ifRevision"]) &&
    isDomainNonempty(value.layer) &&
    (ownDomainValue(value, "ifRevision") === undefined ||
      isDomainNonempty(ownDomainValue(value, "ifRevision")))
  );
}

function isServiceError(value: unknown): value is Readonly<WeaverError> {
  if (
    !isDomainRecord(value) ||
    !hasDomainFields(value, ["code", "message"], ["details"])
  )
    return false;
  return (
    weaverErrorCodes.some((code) => code === value.code) &&
    isDomainString(value.message) &&
    (ownDomainValue(value, "details") === undefined ||
      isDomainRecord(ownDomainValue(value, "details")))
  );
}

export function isConfigurationServiceWriteResult(
  value: unknown,
): value is ConfigurationServiceWriteResult {
  if (!isDomainRecord(value)) return false;
  if (value.success === true)
    return (
      hasDomainFields(value, ["success", "layer", "revision"]) &&
      isDomainNonempty(value.layer) &&
      isDomainNonempty(value.revision)
    );
  return (
    value.success === false &&
    hasDomainFields(value, ["success", "error", "outcome"]) &&
    isServiceError(value.error) &&
    (value.outcome === "rejected" || value.outcome === "unknown") &&
    (value.outcome === "unknown") ===
      (value.error.code === "WRITE_OUTCOME_UNKNOWN")
  );
}

export type CapabilityShape<T> = { -readonly [K in keyof T]: T[K] };

const readerMethods = [
  "get",
  "getWithDefault",
  "getAtLayer",
  "getNamespace",
  "inspect",
  "onChange",
];
const scopedMethods = [...readerMethods, "withScope", "dispose"];
const serviceMethods = [
  ...readerMethods,
  "getForScope",
  "preloadScope",
  "set",
  "remove",
  "reloadProvider",
  "flush",
  "dispose",
];

/** Callables are inspected for shape, never invoked or authenticated. */
export function isHydratedCapability(
  value: unknown,
  kind: "reader" | "service" | "scoped" | "namespace",
): boolean {
  if (!isDomainRecord(value)) return false;
  const root = kind === "reader" || kind === "service";
  const methods =
    kind === "service" ? serviceMethods : root ? readerMethods : scopedMethods;
  const extra =
    kind === "namespace"
      ? ["getFromNamespace", "onRestartRequired", "acknowledgeRestart"]
      : [];
  const fields = root
    ? ["identity", "revision", "mode", "degradedProviders"]
    : ["identity", "namespace"];
  const names: string[] = [];
  for (const group of [fields, methods, extra])
    for (const name of group) appendDomainValue(names, name);
  if (kind === "namespace") appendDomainValue(names, "pendingRestart");
  if (
    !hasDomainFields(value, names) ||
    !isConfigurationServiceIdentity(value.identity)
  )
    return false;
  for (const name of methods)
    if (typeof ownDomainValue(value, name) !== "function") return false;
  for (const name of extra)
    if (typeof ownDomainValue(value, name) !== "function") return false;
  if (!root)
    return (
      isCanonicalConfigurationPath(value.namespace) &&
      (kind !== "namespace" || typeof value.pendingRestart === "boolean")
    );
  return (
    isDomainNonempty(value.revision) &&
    (value.mode === "live" || value.mode === "degraded") &&
    isDenseDomainArray(value.degradedProviders, isDomainNonempty)
  );
}
