import { z } from "zod";
import { weaverErrorCodeSchema } from "./errors";
import { schemaValidationResultSchema } from "./schemas-schema-validation";
import { configurationServiceIdentitySchema } from "./schemas-service-capabilities";
import {
  canonicalConfigurationPathSchema,
  configurationViewIdSchema,
} from "./schemas-service-paths";
import { serviceDataBoundary } from "./service-data-boundary";
import type {
  ConfigurationMutationAuthority,
  ConfigurationValue,
} from "./service-mutations";

// Descriptor admission, detachment and cycle rejection precede this JSON-only
// predicate. Iteration preserves deep JSON and shared acyclic subgraphs.
function isJson(value: unknown): boolean {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    )
      continue;
    if (typeof current === "number" && Number.isFinite(current)) continue;
    if (typeof current !== "object") return false;
    if (seen.has(current)) continue;
    seen.add(current);
    if (
      Array.isArray(current) &&
      Object.keys(current).length !== current.length
    )
      return false;
    for (const child of Object.values(current)) pending.push(child);
  }
  return true;
}

const jsonValue = z.custom<ConfigurationValue>(isJson, "Invalid JSON value");
export const configurationValueSchema = serviceDataBoundary(jsonValue);
function denseArrays(value: unknown): boolean {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || seen.has(current))
      continue;
    seen.add(current);
    if (
      Array.isArray(current) &&
      Object.keys(current).length !== current.length
    )
      return false;
    for (const child of Object.values(current)) pending.push(child);
  }
  return true;
}
const denseData = z.unknown().refine(denseArrays, "Sparse mutation data");
const nonempty = z.string().min(1);
const selection = {
  identity: configurationServiceIdentitySchema,
  namespace: canonicalConfigurationPathSchema,
  layer: nonempty,
  path: canonicalConfigurationPathSchema,
  ifRevision: nonempty.optional(),
  viewId: configurationViewIdSchema.optional(),
  sessionId: z.string().uuid().optional(),
};
export const configurationMutationCommandSchema = serviceDataBoundary(
  denseData.pipe(
    z.discriminatedUnion("operation", [
      z
        .strictObject({
          ...selection,
          operation: z.literal("set"),
          value: jsonValue,
        })
        .readonly(),
      z
        .strictObject({ ...selection, operation: z.literal("remove") })
        .readonly(),
      z
        .strictObject({
          ...selection,
          operation: z.literal("patch"),
          value: jsonValue,
        })
        .readonly(),
    ]),
  ),
);
export const configurationMutationCommandsSchema = serviceDataBoundary(
  denseData.pipe(z.array(configurationMutationCommandSchema).min(1).readonly()),
);

const error = z
  .strictObject({ code: weaverErrorCodeSchema, message: z.string() })
  .readonly();
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const committed = z
  .strictObject({ index, effect: z.literal("committed") })
  .readonly();
export const configurationMutationReceiptSchema = serviceDataBoundary(
  z
    .discriminatedUnion("effect", [
      committed,
      z
        .strictObject({ index, effect: z.literal("rejected"), error })
        .readonly(),
      z.strictObject({ index, effect: z.literal("not-attempted") }).readonly(),
      z.strictObject({ index, effect: z.literal("unknown"), error }).readonly(),
    ])
    .refine(
      (receipt) =>
        !("error" in receipt) ||
        (receipt.effect === "unknown") ===
          (receipt.error.code === "WRITE_OUTCOME_UNKNOWN"),
      "Receipt effect must agree with error code",
    ),
);
export const configurationMutationRevisionSchema = serviceDataBoundary(
  z
    .strictObject({
      identity: configurationServiceIdentitySchema,
      revision: nonempty,
    })
    .readonly(),
);
const revisions = z
  .array(configurationMutationRevisionSchema)
  .min(1)
  .refine(
    (items) =>
      new Set(items.map(({ identity }) => JSON.stringify(identity))).size ===
      items.length,
    "Duplicate revision identity",
  )
  .readonly();
const results = z.array(configurationMutationReceiptSchema).readonly();
const result = z.union([
  z
    .strictObject({
      success: z.literal(true),
      results: z.array(committed).min(1).readonly(),
      revisions,
    })
    .readonly(),
  z
    .strictObject({
      success: z.literal(false),
      outcome: z.literal("rejected"),
      error,
      results,
    })
    .readonly(),
  z
    .strictObject({
      success: z.literal(false),
      outcome: z.literal("partial"),
      error,
      results,
      revisions,
    })
    .readonly(),
  z
    .strictObject({
      success: z.literal(false),
      outcome: z.literal("unknown"),
      error,
      results,
    })
    .readonly(),
]);

function validOutcome(value: z.infer<typeof result>): boolean {
  if (!value.results.every((receipt, position) => receipt.index === position))
    return false;
  if (value.success) return true;
  if (
    (value.outcome === "unknown") !==
    (value.error.code === "WRITE_OUTCOME_UNKNOWN")
  )
    return false;
  if (value.outcome === "unknown") return validUnknownReceipts(value.results);
  const stop = value.results.findIndex(
    (receipt) => receipt.effect === "rejected",
  );
  if (value.outcome === "rejected")
    return value.results.every(
      (receipt, position) =>
        receipt.effect === (position === stop ? "rejected" : "not-attempted"),
    );
  return (
    stop > 0 &&
    value.results.every(
      (receipt, position) =>
        receipt.effect ===
        (position < stop
          ? "committed"
          : position === stop
            ? "rejected"
            : "not-attempted"),
    )
  );
}

function validUnknownReceipts(receipts: z.infer<typeof results>): boolean {
  const stop = receipts.findIndex(
    ({ effect }) => effect === "rejected" || effect === "not-attempted",
  );
  // Flush uncertainty may interleave committed/unknown receipts in the attempted
  // prefix. A rejection or unattempted command still ends that prefix.
  return (
    receipts.some(({ effect }) => effect === "unknown") &&
    (stop < 0 ||
      receipts
        .slice(stop + 1)
        .every(({ effect }) => effect === "not-attempted"))
  );
}

export const configurationMutationResultSchema = serviceDataBoundary(
  result.refine(validOutcome, "Inconsistent mutation outcome"),
);
export const configurationMutationAuthoritySchema = serviceDataBoundary(
  z.strictObject({
    apply: z.custom<ConfigurationMutationAuthority["apply"]>(
      (value) => typeof value === "function",
    ),
  }),
);
export const configurationValidationResponseSchema = serviceDataBoundary(
  z
    .strictObject({
      identity: configurationServiceIdentitySchema,
      revision: nonempty,
      path: canonicalConfigurationPathSchema,
      validation: schemaValidationResultSchema,
    })
    .readonly(),
);
