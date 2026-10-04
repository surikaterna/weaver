import {
  type ConfigurationServiceIdentity,
  type ConfigurationServiceOptions,
  type ConfigurationServiceProviderBinding,
  createWeaverError,
} from "@weaver-conf/config-types";
import { type CapturedBinding, eligible } from "./provider-binding";

export interface SelectedBinding {
  readonly captured: CapturedBinding;
  readonly rank: number;
  readonly kind: "fixed" | "scope";
}
export function identityKey(identity: ConfigurationServiceIdentity): string {
  return JSON.stringify([
    identity.environment,
    identity.scopePath.map(({ scopeId, value }) => [scopeId, value]),
  ]);
}
function prefixKey(binding: ConfigurationServiceProviderBinding): string {
  return JSON.stringify(
    binding.scopePath?.map(({ scopeId, value }) => [scopeId, value]),
  );
}
function intersects(
  a: ConfigurationServiceProviderBinding,
  b: ConfigurationServiceProviderBinding,
): boolean {
  return (
    a.environment.kind === "common" ||
    b.environment.kind === "common" ||
    a.environment.environments.some((environment) => eligible(b, environment))
  );
}

export function validateStack(options: ConfigurationServiceOptions): void {
  const ids = new Set(options.providers.map((binding) => binding.id));
  const layers = new Set(options.layers.map((slot) => slot.layer));
  if (
    ids.size !== options.providers.length ||
    layers.size !== options.layers.length
  )
    throw createWeaverError("VALIDATION_ERROR", "Duplicate provider or layer");
  const assigned = new Set<string>();
  for (const slot of options.layers) validateSlot(slot, options, assigned);
  if (assigned.size !== ids.size)
    throw createWeaverError("VALIDATION_ERROR", "Unused provider binding");
}

function validateSlot(
  slot: ConfigurationServiceOptions["layers"][number],
  options: ConfigurationServiceOptions,
  assigned: Set<string>,
): void {
  const bindings: ConfigurationServiceProviderBinding[] = [];
  for (const id of slot.providerIds) {
    const binding = options.providers.find((candidate) => candidate.id === id);
    if (!binding || assigned.has(id) || binding.layer !== slot.layer)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Missing or multiply assigned binding",
      );
    validateSelectors(slot.kind, binding);
    if (
      bindings.some(
        (other) =>
          prefixKey(other) === prefixKey(binding) && intersects(other, binding),
      )
    )
      throw createWeaverError("VALIDATION_ERROR", "Ambiguous provider binding");
    assigned.add(id);
    bindings.push(binding);
  }
}

function validateSelectors(
  kind: "fixed" | "scope",
  binding: ConfigurationServiceProviderBinding,
): void {
  if (
    (kind === "fixed" && binding.scopePath !== undefined) ||
    (kind === "scope" &&
      (!binding.scopePath?.length || binding.environment.kind === "common"))
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Binding scope does not match slot",
    );
  if (
    binding.environment.kind === "environments" &&
    new Set(binding.environment.environments).size !==
      binding.environment.environments.length
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Duplicate environment selector",
    );
  if (
    binding.scopePath &&
    new Set(binding.scopePath.map((scope) => scope.scopeId)).size !==
      binding.scopePath.length
  )
    throw createWeaverError("VALIDATION_ERROR", "Duplicate binding scope");
}

export function selectBindings(
  options: ConfigurationServiceOptions,
  captured: readonly CapturedBinding[],
  identity: ConfigurationServiceIdentity,
): readonly SelectedBinding[] {
  const selected: SelectedBinding[] = [];
  options.layers.forEach((slot, rank) => {
    const prefixes =
      slot.kind === "fixed"
        ? [undefined]
        : identity.scopePath.map((_, index) =>
            identity.scopePath.slice(0, index + 1),
          );
    for (const prefix of prefixes) {
      const key = JSON.stringify(
        prefix?.map(({ scopeId, value }) => [scopeId, value]),
      );
      const match = captured.find(
        ({ binding }) =>
          slot.providerIds.includes(binding.id) &&
          eligible(binding, identity.environment) &&
          prefixKey(binding) === key,
      );
      if (!match)
        throw createWeaverError(
          slot.kind === "fixed" ? "VALIDATION_ERROR" : "SCOPE_NOT_FOUND",
          "No provider binding for requested identity",
        );
      selected.push({ captured: match, rank, kind: slot.kind });
    }
  });
  return selected;
}
