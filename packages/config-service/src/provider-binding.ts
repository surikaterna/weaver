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
  return { binding, load: methodLoad(provider, operation) };
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
