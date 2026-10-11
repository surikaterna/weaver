import type { z } from "zod";
import type { WeaverError } from "./errors";
import type { Result } from "./result";
import type {
  configurationSessionActivationSchema,
  configurationSessionDeactivationSchema,
  configurationSessionExtensionSchema,
  configurationSessionInfoSchema,
  configurationSessionSelectionSchema,
  sessionAuthorizationRequestSchema,
} from "./schemas-service-sessions";

export type ConfigurationSessionActivation = z.infer<
  typeof configurationSessionActivationSchema
>;
export type ConfigurationSessionExtension = z.infer<
  typeof configurationSessionExtensionSchema
>;
export type ConfigurationSessionSelection = z.infer<
  typeof configurationSessionSelectionSchema
>;
export type ConfigurationSessionInfo = z.infer<
  typeof configurationSessionInfoSchema
>;
export type ConfigurationSessionDeactivation = z.infer<
  typeof configurationSessionDeactivationSchema
>;
export type SessionAuthorizationRequest = z.infer<
  typeof sessionAuthorizationRequestSchema
>;
export interface ConfigurationSessionAuthority {
  activate(
    request: ConfigurationSessionActivation,
  ): Promise<Result<ConfigurationSessionInfo, WeaverError>>;
  extend(
    request: ConfigurationSessionExtension,
  ): Promise<Result<ConfigurationSessionInfo, WeaverError>>;
  deactivate(
    request: ConfigurationSessionSelection,
  ): Promise<Result<ConfigurationSessionDeactivation, WeaverError>>;
  get(sessionId: string): ConfigurationSessionInfo | null;
  list(): readonly ConfigurationSessionInfo[];
}
export {
  configurationSessionActivationSchema,
  configurationSessionAuthoritySchema,
  configurationSessionDeactivationSchema,
  configurationSessionExtensionSchema,
  configurationSessionInfoSchema,
  configurationSessionSelectionSchema,
  sessionAuthorizationRequestSchema,
} from "./schemas-service-sessions";
