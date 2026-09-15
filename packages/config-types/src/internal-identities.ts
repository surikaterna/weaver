import { z } from "zod";
import { createWeaverError } from "./errors";

export const internalIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
  .refine(
    (value) => value !== "constructor" && value !== "prototype",
    "Unsafe identifier",
  );
export const internalDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const internalRecordIdSchema = z.string().regex(/^[a-f0-9]+$/);
export const credentialReferenceSchema = internalIdSchema;

/** Portable UTF-8 identity encoding; identity is derived, never a second path authority. */
export function encodeInternalIdentity(value: readonly unknown[]): string {
  return [...new TextEncoder().encode(JSON.stringify(value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalInternalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalInternalJson).join(",")}]`;
  if (typeof value !== "object" || value === null)
    throw createWeaverError("VALIDATION_ERROR", "Expected a JSON value");
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, child]) =>
        `${JSON.stringify(key)}:${canonicalInternalJson(child)}`,
    )
    .join(",")}}`;
}
