import type { z } from "zod";
import type {
  configurationMutationCommandSchema,
  configurationMutationReceiptSchema,
  configurationMutationResultSchema,
  configurationMutationRevisionSchema,
  configurationValidationResponseSchema,
} from "./schemas-service-mutations";

/** Detached ordinary JSON data; the boundary rejects cycles and executable values. */
export type ConfigurationValue =
  | null
  | boolean
  | number
  | string
  | readonly ConfigurationValue[]
  | { readonly [key: string]: ConfigurationValue };

export type ConfigurationMutationCommand = z.infer<
  typeof configurationMutationCommandSchema
>;
export type ConfigurationMutationReceipt = z.infer<
  typeof configurationMutationReceiptSchema
>;
export type ConfigurationMutationRevision = z.infer<
  typeof configurationMutationRevisionSchema
>;
export type ConfigurationMutationResult = z.infer<
  typeof configurationMutationResultSchema
>;
export type ConfigurationValidationResponse = z.infer<
  typeof configurationValidationResponseSchema
>;

/** A list is ordered, not transactional. Committed receipts describe storage effects. */
export interface ConfigurationMutationAuthority {
  apply(
    commands: readonly ConfigurationMutationCommand[],
  ): Promise<ConfigurationMutationResult>;
}
