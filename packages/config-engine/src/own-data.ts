import { createWeaverError } from "@weaver-conf/config-types";

export function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) {
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Accessors are not configuration data",
    );
  }
  const data: unknown = descriptor.value;
  return data;
}

export function defineOwnData(
  target: object,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
