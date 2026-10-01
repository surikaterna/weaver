import {
  createWeaverError,
  providerIdSchema,
  serviceIdSchema,
  slotPathSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";
import { copySnapshotData } from "./descriptor-copy";
import { assertSafePathSegment, buildPath, parsePath } from "./path";

export const WEAVER_INTERNAL_ROOT = "/_weaver";

export interface DerivedServicePath {
  readonly serviceId: string;
  readonly servicePath: string;
}

export interface DerivedFragmentPath extends DerivedServicePath {
  readonly providerId: string;
  readonly canonicalSlotPath: string;
  readonly fragmentPath: string;
}

export interface CanonicalConfigPath {
  readonly path: string;
  readonly segments: readonly string[];
  readonly storageKey: string;
}

export const canonicalConfigPathSchema = z.preprocess(
  (input) => copySnapshotData(input, true),
  z
    .strictObject({
      path: z.string(),
      segments: z.array(z.string()).readonly(),
      storageKey: z.string(),
    })
    .superRefine(validateCanonicalConfigPath)
    .readonly(),
);

export function parseCanonicalConfigPath(path: string): CanonicalConfigPath {
  if (typeof path !== "string")
    throw createWeaverError("VALIDATION_ERROR", "Path must be a string");
  if (!path.startsWith("/")) invalidPath(path, "must start with /");
  if (path.length > 1 && path.includes("//")) {
    invalidPath(path, "contains empty segments");
  }
  const segments = path === "/" ? [] : path.slice(1).split("/");
  if (segments.at(-1) === "") segments.pop();
  return canonicalConfigPathFromSegments(segments);
}

export function canonicalConfigPathFromSegments(
  segments: readonly string[],
): CanonicalConfigPath {
  const copied = copySnapshotData(segments);
  if (!ownStringSegments(copied))
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Path segments must be own strings",
    );
  for (const segment of copied) validateCanonicalSegment(segment);
  const path = copied.length === 0 ? "/" : `/${copied.join("/")}`;
  return canonicalConfigPathSchema.parse({
    path,
    segments: copied,
    storageKey: buildPath(copied),
  });
}

export function canonicalConfigPathFromStorageKey(
  storageKey: string,
): CanonicalConfigPath {
  if (typeof storageKey !== "string")
    throw createWeaverError("VALIDATION_ERROR", "Storage key must be a string");
  if (storageKey.length === 0) return canonicalConfigPathFromSegments([]);
  return canonicalConfigPathFromSegments(parsePath(storageKey));
}

export function normalizeConfigPath(path: string): string {
  return parseCanonicalConfigPath(path).path;
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
  if (!slotPathSchema.safeParse(slotPath).success) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Invalid slotPath "${slotPath}"`,
    );
  }
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
  if (typeof serviceId !== "string")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Service identifier must be a string",
    );
  assertSafePathSegment(serviceId);
  if (!serviceIdSchema.safeParse(serviceId).success) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Invalid serviceId "${serviceId}"`,
    );
  }
}

function validateProviderId(providerId: string): void {
  if (typeof providerId !== "string")
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Provider identifier must be a string",
    );
  assertSafePathSegment(providerId);
  if (!providerIdSchema.safeParse(providerId).success) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `providerId "${providerId}" must be one path segment`,
    );
  }
}

function validateCanonicalSegment(segment: string): void {
  assertSafePathSegment(segment);
  if (
    segment.length === 0 ||
    segment.includes("/") ||
    segment.includes("[") ||
    segment.includes("]")
  ) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      `Path segment "${segment}" is not canonical`,
    );
  }
}

function invalidPath(path: string, reason: string): never {
  throw createWeaverError("VALIDATION_ERROR", `Path "${path}" ${reason}`);
}

function validateCanonicalConfigPath(
  value: CanonicalConfigPath,
  context: z.RefinementCtx,
): void {
  try {
    for (const segment of value.segments) validateCanonicalSegment(segment);
    const expectedPath =
      value.segments.length === 0 ? "/" : `/${value.segments.join("/")}`;
    if (value.path !== expectedPath)
      context.addIssue({ code: "custom", message: "Canonical path mismatch" });
    if (value.storageKey !== buildPath(value.segments))
      context.addIssue({ code: "custom", message: "Storage key mismatch" });
  } catch {
    context.addIssue({ code: "custom", message: "Invalid canonical path" });
  }
}

function ownStringSegments(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string"
    )
      return false;
  }
  return true;
}
