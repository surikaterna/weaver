import { createWeaverError } from "./errors";
import { captureServiceData } from "./service-data-boundary";

/** Read only caller-owned data slots; providers remain opaque host capabilities. */
function ownRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw createWeaverError("VALIDATION_ERROR", "Invalid factory record");
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype)
    throw createWeaverError("VALIDATION_ERROR", "Invalid factory prototype");
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    )
      throw createWeaverError("VALIDATION_ERROR", "Invalid factory descriptor");
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
    });
  }
  return output;
}

function data(input: unknown): unknown {
  const captured = captureServiceData(input);
  if (!captured.success)
    throw createWeaverError("VALIDATION_ERROR", "Invalid factory data");
  return captured.value;
}

function providerRows(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  if (Object.getPrototypeOf(input) !== Array.prototype)
    throw createWeaverError("VALIDATION_ERROR", "Invalid provider array");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
    )
  )
    throw createWeaverError("VALIDATION_ERROR", "Invalid provider array");
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw createWeaverError("VALIDATION_ERROR", "Invalid provider slot");
    const row = ownRecord(descriptor.value);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(row))
      Object.defineProperty(output, key, {
        value: key === "provider" ? row[key] : data(row[key]),
        enumerable: true,
      });
    return output;
  });
}

export function captureConfigurationServiceOptions(input: unknown): unknown {
  const row = ownRecord(input);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(row))
    Object.defineProperty(output, key, {
      value: key === "providers" ? providerRows(row[key]) : data(row[key]),
      enumerable: true,
    });
  return output;
}

/** Prototype method lookup is permitted, but accessor capabilities are not invoked. */
export function configurationProviderMember(
  input: object,
  key: string,
): unknown {
  let current: object | null = input;
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

export function isConfigurationStorageCapability(input: unknown): boolean {
  try {
    if (input === null || typeof input !== "object") return false;
    return (
      typeof configurationProviderMember(input, "id") === "string" &&
      typeof configurationProviderMember(input, "layer") === "string" &&
      typeof configurationProviderMember(input, "writable") === "boolean" &&
      ["load", "write", "remove"].every(
        (key) => typeof configurationProviderMember(input, key) === "function",
      )
    );
  } catch {
    return false;
  }
}
