import {
  type ConfigurationProviderWriteBinding,
  type ConfigurationServiceIdentity,
  type ConfigurationStorageProvider,
  createWeaverError,
} from "@weaver-conf/config-types";
import { z } from "zod";
import type { CapturedBinding } from "../provider-binding";
import { invalidHost, portMember } from "./authority-contract-capture";

export interface CapturedWriter {
  readonly declaration: ConfigurationProviderWriteBinding;
  readonly write: (key: string, value: unknown) => Promise<unknown>;
  readonly remove: (key: string) => Promise<unknown>;
  readonly flush?: () => Promise<unknown>;
}
function method<T>(provider: object, name: string): T {
  return z
    .custom<T>((value) => typeof value === "function")
    .parse(portMember(provider, name));
}
function methods(
  binding: CapturedBinding,
  declaration: ConfigurationProviderWriteBinding,
) {
  const provider = binding.binding.provider;
  if (portMember(provider, "writable") !== true)
    throw createWeaverError("WRITE_UNAVAILABLE", "Provider is read-only");
  const operation = declaration.operation;
  if (operation.kind === "write-layer") {
    const write = method<
      NonNullable<ConfigurationStorageProvider["writeLayer"]>
    >(provider, "writeLayer");
    const remove = method<
      NonNullable<ConfigurationStorageProvider["removeLayer"]>
    >(provider, "removeLayer");
    return {
      write: (key: string, value: unknown) =>
        write.call(provider, operation.layer, key, value),
      remove: (key: string) => remove.call(provider, operation.layer, key),
    };
  }
  const write = method<ConfigurationStorageProvider["write"]>(
    provider,
    "write",
  );
  const remove = method<ConfigurationStorageProvider["remove"]>(
    provider,
    "remove",
  );
  return {
    write: (key: string, value: unknown) => write.call(provider, key, value),
    remove: (key: string) => remove.call(provider, key),
  };
}
function validateDialect(
  captured: CapturedBinding,
  declaration: ConfigurationProviderWriteBinding,
  identity: ConfigurationServiceIdentity,
): void {
  const { environment, operation } = captured.binding;
  if (
    environment.kind !== "environments" ||
    environment.environments.length !== 1 ||
    environment.environments[0] !== identity.environment
  )
    invalidHost();
  if (operation.kind === "read") invalidHost();
  if (operation.kind === "load" && declaration.operation.kind !== "write")
    invalidHost();
  if (
    operation.kind === "load-layer" &&
    (declaration.operation.kind !== "write-layer" ||
      operation.layer !== declaration.operation.layer)
  )
    invalidHost();
}
export function captureWriters(
  captured: readonly CapturedBinding[],
  declarations: readonly ConfigurationProviderWriteBinding[] = [],
  identity: ConfigurationServiceIdentity,
): ReadonlyMap<CapturedBinding, CapturedWriter> {
  const writers = new Map<CapturedBinding, CapturedWriter>();
  for (const declaration of declarations) {
    const binding = captured.find(
      (item) => item.binding.id === declaration.providerId,
    );
    if (!binding || writers.has(binding)) invalidHost();
    validateDialect(binding, declaration, identity);
    const provider = binding.binding.provider;
    if ([...writers.keys()].some((item) => item.binding.provider === provider))
      invalidHost();
    const ports = methods(binding, declaration);
    const flush =
      declaration.flush === "required"
        ? method<NonNullable<ConfigurationStorageProvider["flush"]>>(
            provider,
            "flush",
          )
        : undefined;
    writers.set(
      binding,
      Object.freeze({
        declaration,
        ...ports,
        ...(flush ? { flush: () => flush.call(provider) } : {}),
      }),
    );
  }
  return writers;
}
