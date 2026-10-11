import type { AuthFunctions } from "@weaver-conf/config-auth";
import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import {
  type ConfigurationMutationCommand,
  canonicalConfigurationPathSchema,
  configurationMutationCommandsSchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import { assertLive, type RootState } from "../root-state";
import type { MutationTicket } from "./authority-write";
import type { createCapabilityRegistry } from "./capability-registry";

export function captureMutations(
  state: RootState,
  registry: ReturnType<typeof createCapabilityRegistry>,
  auth: AuthFunctions | undefined,
  token: unknown,
  input: unknown,
): MutationTicket {
  assertLive(state);
  if (
    !auth ||
    (!state.factory.writers.size && !state.factory.host.sessions) ||
    state.writeFence ||
    state.schemaFence
  )
    throw createWeaverError("WRITE_UNAVAILABLE", "Mutations are unavailable");
  if (state.writeHookActive)
    throw createWeaverError("FORBIDDEN", "Authority callback reentry denied");
  const principal = registry.current(token).snapshot;
  const captured = configurationMutationCommandsSchema.safeParse(input);
  if (!captured.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid mutation commands");
  const check = () => {
    assertLive(state);
    if (state.writeFence || state.schemaFence)
      throw createWeaverError("WRITE_UNAVAILABLE", "Mutations are fenced");
    if (registry.current(token).snapshot !== principal)
      throw createWeaverError("FORBIDDEN", "Mutation authority changed");
  };
  return Object.freeze({
    commands: captured.data,
    principal,
    auth,
    check,
    token,
  });
}

export function validateMutationSelection(
  command: ConfigurationMutationCommand,
): void {
  compileMutationPath(command);
  if (command.operation !== "remove") rejectInstancePayload(command.value);
}

/** Only this trusted compiler translates logical view requests into storage paths. */
export function compileMutationPath(command: ConfigurationMutationCommand) {
  const namespace = parseCanonicalConfigPath(command.namespace).segments;
  const logical = parseCanonicalConfigPath(command.path).segments;
  if (
    logical.includes("instances") ||
    namespace.includes("instances") ||
    namespace.length > logical.length ||
    !namespace.every((part, index) => logical[index] === part)
  )
    throw createWeaverError("FORBIDDEN", "Mutation path escapes its selection");
  const physical =
    command.viewId === undefined
      ? logical
      : [
          ...namespace,
          "instances",
          command.viewId,
          ...logical.slice(namespace.length),
        ];
  return canonicalConfigurationPathSchema.parse(`/${physical.join("/")}`);
}

function rejectInstancePayload(value: unknown): void {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (Object.hasOwn(item, "instances"))
      throw createWeaverError(
        "FORBIDDEN",
        "Instance storage requires an explicit view selection",
      );
    for (const child of Object.values(item)) pending.push(child);
  }
}
