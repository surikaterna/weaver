import {
  type ConfigurationLayerData,
  type ConfigurationServiceIdentity,
  type ConfigurationServiceProviderBinding,
  type ConfigurationStorageProvider,
  createWeaverError,
} from "@weaver-conf/config-types";
import { z } from "zod";

export interface CapturedBinding {
  readonly binding: ConfigurationServiceProviderBinding;
  readonly load: (
    identity: ConfigurationServiceIdentity,
  ) => Promise<ConfigurationLayerData>;
  readonly refresh?: () => Promise<void>;
  readonly watch?: (hint: () => void) => unknown;
}

function member(provider: object, key: string): unknown {
  let current: object | null = provider;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!("value" in descriptor))
        throw createWeaverError(
          "VALIDATION_ERROR",
          "Accessor provider capability",
        );
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

export function captureBinding(
  binding: ConfigurationServiceProviderBinding,
): CapturedBinding {
  const { provider, operation } = binding;
  const lifecycle = captureLifecycle(binding);
  if (
    member(provider, "id") !== binding.id ||
    member(provider, "layer") !== binding.layer
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Provider identity does not match binding",
    );
  if (operation.kind === "read") {
    const read = operation.read;
    return {
      binding,
      ...lifecycle,
      load: (identity) =>
        read(
          Object.freeze({
            identity,
            layer: binding.layer,
            scopePath: binding.scopePath ?? Object.freeze([]),
          }),
        ),
    };
  }
  return { binding, ...lifecycle, load: methodLoad(provider, operation) };
}

function captureLifecycle(binding: ConfigurationServiceProviderBinding) {
  const provider = binding.provider;
  const refresh = member(provider, "refresh");
  if (refresh !== undefined && typeof refresh !== "function")
    throw createWeaverError("VALIDATION_ERROR", "Invalid provider refresh");
  const watch =
    binding.watch === true ? member(provider, "onExternalChange") : undefined;
  if (
    binding.watch === true &&
    (typeof watch !== "function" ||
      (binding.operation.kind === "load-layer" &&
        binding.operation.layer !== binding.layer))
  )
    throw createWeaverError(
      "UNSUPPORTED_OPERATION",
      "Provider watch is unavailable for this binding",
    );
  return {
    ...(typeof refresh === "function"
      ? {
          refresh: async () => {
            await refresh.call(provider);
          },
        }
      : {}),
    ...(typeof watch === "function"
      ? { watch: (hint: () => void): unknown => watch.call(provider, hint) }
      : {}),
  };
}

function methodLoad(
  provider: ConfigurationStorageProvider,
  operation: Exclude<
    ConfigurationServiceProviderBinding["operation"],
    { kind: "read" }
  >,
): CapturedBinding["load"] {
  if (operation.kind === "load-layer") {
    const loadLayer = z
      .custom<NonNullable<ConfigurationStorageProvider["loadLayer"]>>(
        (value) => typeof value === "function",
      )
      .parse(member(provider, "loadLayer"));
    return () => loadLayer.call(provider, operation.layer);
  }
  const load = z
    .custom<ConfigurationStorageProvider["load"]>(
      (value) => typeof value === "function",
    )
    .parse(member(provider, "load"));
  return () => load.call(provider);
}

export function eligible(
  binding: ConfigurationServiceProviderBinding,
  environment: string,
): boolean {
  return (
    binding.environment.kind === "common" ||
    binding.environment.environments.includes(environment)
  );
}
