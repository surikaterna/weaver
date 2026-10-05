import type { CanonicalSchemaRegistryReader } from "@weaver-conf/config-registry";
import {
  captureServiceData,
  writeResultSchema,
} from "@weaver-conf/config-types";
import { z } from "zod";
import { ownRecord, portMember } from "./authority-contract-capture";

export type AdmissionRegistry = Pick<
  CanonicalSchemaRegistryReader,
  "listRegisteredSchemaIdentities" | "getRegisteredSchema"
>;
export const admissionRegistrySchema = z.custom<AdmissionRegistry>((value) => {
  if (!value || typeof value !== "object") return false;
  try {
    return ["listRegisteredSchemaIdentities", "getRegisteredSchema"].every(
      (key) => typeof portMember(value, key) === "function",
    );
  } catch {
    return false;
  }
});
function ownedData(input: unknown): unknown {
  const captured = captureServiceData(input);
  return captured.success ? captured.value : undefined;
}
function captureContext(input: unknown): unknown {
  try {
    const fields = ownRecord(input);
    return {
      ...fields,
      mutations: ownedData(fields.mutations),
      layerBefore: ownedData(fields.layerBefore),
    };
  } catch {
    return undefined;
  }
}
export const mutationSchema = z.preprocess(
  ownedData,
  z
    .strictObject({
      key: z.string(),
      value: z.unknown().optional(),
      operation: z.enum(["set", "remove"]),
      dedicated: z.boolean().optional(),
      admissionKey: z.string().optional(),
      admissionValue: z.unknown().optional(),
    })
    .readonly(),
);
export type Mutation = z.infer<typeof mutationSchema>;
const entriesSchema = z.record(z.string(), z.unknown());
export const admissionContextSchema = z.preprocess(
  captureContext,
  z
    .strictObject({
      registry: admissionRegistrySchema.optional(),
      environment: z.string(),
      mutations: z.array(mutationSchema).readonly(),
      layerBefore: entriesSchema,
      effectiveAfter: z.custom<
        (entries: Record<string, unknown>) => Record<string, unknown>
      >((value) => typeof value === "function"),
    })
    .readonly(),
);
export type AdmissionContext = z.infer<typeof admissionContextSchema>;
export const preparedMutationSchema = z.preprocess(
  ownedData,
  z.discriminatedUnion("success", [
    z
      .strictObject({ success: z.literal(true), layerAfter: entriesSchema })
      .readonly(),
    z
      .strictObject({ success: z.literal(false), result: writeResultSchema })
      .readonly(),
  ]),
);
export type PreparedMutation = z.infer<typeof preparedMutationSchema>;
