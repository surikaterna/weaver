import { z } from "zod";

export const configurationProjectionActionSchema = z.enum([
  "retain",
  "omit",
  "descend",
]);
export type ConfigurationProjectionAction = z.infer<
  typeof configurationProjectionActionSchema
>;

// Trusted library callbacks: callable shape is not configuration authority.
export interface ConfigurationProjectionVisitor<C extends object> {
  readonly decide: (
    value: unknown,
    context: C,
  ) => ConfigurationProjectionAction;
  readonly child: (context: C, key: string) => C;
  /** Compatibility representation only; registered reads leave omitted indices as holes. */
  readonly preserveUndefinedArraySlots?: boolean | undefined;
  /** Compatibility only: retain mutable descended containers, never borrowed inputs. */
  readonly mutableContainers?: boolean | undefined;
}

// Package-private callable-shape evidence, not callback invocation or authority.
export const configurationProjectionVisitorSchema: z.ZodType<
  ConfigurationProjectionVisitor<object>
> = z.strictObject({
  decide: z.custom<ConfigurationProjectionVisitor<object>["decide"]>(
    (value) => typeof value === "function",
  ),
  child: z.custom<ConfigurationProjectionVisitor<object>["child"]>(
    (value) => typeof value === "function",
  ),
  preserveUndefinedArraySlots: z.boolean().optional(),
  mutableContainers: z.boolean().optional(),
});
