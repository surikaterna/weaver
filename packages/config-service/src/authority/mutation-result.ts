import {
  type ConfigurationMutationCommand,
  type ConfigurationMutationReceipt,
  type ConfigurationMutationResult,
  type ConfigurationMutationRevision,
  type WeaverErrorCode,
  WeaverErrorInstance,
} from "@weaver-conf/config-types";
import { identityKey } from "../layer-stack";

export function mutationError(error: unknown): {
  readonly code: WeaverErrorCode;
  readonly message: string;
} {
  const code =
    error instanceof WeaverErrorInstance ? error.code : "VALIDATION_ERROR";
  return Object.freeze({
    code,
    message:
      code === "WRITE_OUTCOME_UNKNOWN"
        ? "Configuration mutation outcome is unknown"
        : "Configuration mutation rejected",
  });
}
export function mutationRejection(
  error: unknown,
  commands: readonly ConfigurationMutationCommand[] = [],
  index = 0,
): ConfigurationMutationResult {
  const failure = mutationError(error);
  return Object.freeze({
    success: false,
    outcome: "rejected",
    error: failure,
    results: Object.freeze(
      commands.map(
        (_, position): ConfigurationMutationReceipt =>
          position === index
            ? Object.freeze({
                index: position,
                effect: "rejected",
                error: failure,
              })
            : Object.freeze({ index: position, effect: "not-attempted" }),
      ),
    ),
  });
}

export function mutationRevisions(
  commands: readonly ConfigurationMutationCommand[],
  revision: string,
): readonly ConfigurationMutationRevision[] {
  const revisions = new Map<string, ConfigurationMutationRevision>();
  for (const command of commands)
    revisions.set(
      identityKey(command.identity),
      Object.freeze({ identity: command.identity, revision }),
    );
  return Object.freeze([...revisions.values()]);
}
