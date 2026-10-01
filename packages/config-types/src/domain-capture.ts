import { z } from "zod";

export type DomainCapture<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false };

export function captureDomain<T>(
  input: unknown,
  guard: (value: unknown) => value is T,
): DomainCapture<T> {
  return guard(input) ? { success: true, value: input } : { success: false };
}

/** A closed domain adapter, not an interpreter of Zod definitions or authority. */
export function domainSchema<Input, Output>(
  capture: (input: unknown) => DomainCapture<Output>,
  message: string | ((input: unknown) => string),
) {
  // The success-only custom stage preserves the public input type. The capture,
  // not this stage, validates the unknown runtime input before reading fields.
  return z
    .custom<Input>(() => true)
    .transform((input, context) => {
      const result = capture(input);
      if (result.success) return result.value;
      Object.defineProperty(context.issues, String(context.issues.length), {
        value: {
          code: "custom",
          message: typeof message === "string" ? message : message(input),
          input: undefined,
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return z.NEVER;
    });
}

export function ownDomainValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

export function appendDomainValue<T>(values: T[], value: T): void {
  Object.defineProperty(values, String(values.length), {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function isDomainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasDomainFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  for (const key of required) if (!Object.hasOwn(value, key)) return false;
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) return false;
  }
  return true;
}

export function isDenseDomainArray<T>(
  value: unknown,
  guard: (value: unknown) => value is T,
): value is T[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || !guard(ownDomainValue(value, index)))
      return false;
  }
  return true;
}

export function isDomainString(value: unknown): value is string {
  return typeof value === "string";
}
export function isDomainNonempty(value: unknown): value is string {
  return isDomainString(value) && value.length > 0;
}
