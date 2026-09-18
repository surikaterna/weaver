import { createWeaverError } from "@weaver-conf/config-types";

export const WEAVER_INTERNAL_ROOT = "/_weaver";

const SERVICE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface DerivedServicePath {
  readonly serviceId: string;
  readonly servicePath: string;
}

export interface DerivedFragmentPath extends DerivedServicePath {
  readonly providerId: string;
  readonly canonicalSlotPath: string;
  readonly fragmentPath: string;
}

export function normalizeConfigPath(path: string): string {
  if (!path.startsWith("/")) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Path "${path}" must start with /`,
    );
  }
  if (path.length > 1 && path.includes("//")) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Path "${path}" contains empty segments`,
    );
  }

  const segments = path.split("/").filter((segment, index) => {
    if (index === 0) return false;
    if (segment.length === 0) return false;
    return true;
  });
  if (segments.length === 0) return "/";
  return `/${segments.join("/")}`;
}

export function isWeaverInternalPath(path: string): boolean {
  const normalized = normalizeConfigPath(path);
  return (
    normalized === WEAVER_INTERNAL_ROOT ||
    normalized.startsWith(`${WEAVER_INTERNAL_ROOT}/`)
  );
}

export function assertPublicConfigPath(path: string): string {
  const normalized = normalizeConfigPath(path);
  if (isWeaverInternalPath(normalized)) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Path "${normalized}" is reserved for Weaver registry metadata`,
    );
  }
  return normalized;
}

export function deriveServicePath(serviceId: string): DerivedServicePath {
  validateServiceId(serviceId);
  const servicePath = assertPublicConfigPath(`/${serviceId}`);
  return { serviceId, servicePath };
}

export function deriveCanonicalSlotPath(
  serviceId: string,
  slotPath: string,
): string {
  const { servicePath } = deriveServicePath(serviceId);
  const normalizedSlotPath = assertPublicConfigPath(slotPath);
  if (normalizedSlotPath === "/") {
    throw createWeaverError("VALIDATION_ERROR", "slotPath must not be root");
  }
  const [firstSegment] = normalizedSlotPath.slice(1).split("/");
  if (firstSegment === serviceId) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `slotPath "${normalizedSlotPath}" must be service-relative`,
    );
  }
  return `${servicePath}${normalizedSlotPath}`;
}

export function deriveFragmentPath(
  serviceId: string,
  slotPath: string,
  providerId: string,
): DerivedFragmentPath {
  validateProviderId(providerId);
  const service = deriveServicePath(serviceId);
  const canonicalSlotPath = deriveCanonicalSlotPath(serviceId, slotPath);
  const fragmentPath = assertPublicConfigPath(
    `${canonicalSlotPath}/${providerId}`,
  );
  return { ...service, providerId, canonicalSlotPath, fragmentPath };
}

function validateServiceId(serviceId: string): void {
  if (!SERVICE_ID_PATTERN.test(serviceId)) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `serviceId "${serviceId}" must match ${SERVICE_ID_PATTERN.source}`,
    );
  }
}

function validateProviderId(providerId: string): void {
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `providerId "${providerId}" must be one path segment`,
    );
  }
}
