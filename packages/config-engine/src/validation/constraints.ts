import { deepEqual } from "../deep-equal";
import {
  addBoundedError,
  addError,
  compileSchemaPattern,
  type ValidationState,
} from "./support";

interface DecimalNumber {
  readonly coefficient: bigint;
  readonly scale: number;
}

const DECIMAL_PATTERN = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/i;

export function validateValueConstraints(state: ValidationState): void {
  validateConstAndEnum(state);
  if (typeof state.value === "string") validateStringConstraints(state);
  if (typeof state.value === "number") validateNumberConstraints(state);
}

function validateConstAndEnum(state: ValidationState): void {
  if (
    state.schema.const !== undefined &&
    !deepEqual(state.value, state.schema.const)
  ) {
    addError(state, "invalid-value", "Value does not match const constraint");
  }
  if (
    state.schema.enum !== undefined &&
    !state.schema.enum.some((item) => deepEqual(item, state.value))
  ) {
    addError(state, "invalid-value", "Value is not in the allowed enum values");
  }
}

function validateStringConstraints(state: ValidationState): void {
  const value = state.value;
  if (typeof value !== "string") return;
  const length = countCodePoints(value);
  addBoundedError(state, "minLength", length, state.schema.minLength, ">=");
  addBoundedError(state, "maxLength", length, state.schema.maxLength, "<=");
  if (state.schema.pattern === undefined) return;
  const regex = compileSchemaPattern(
    state.schema.pattern,
    state.path,
    state.context,
  );
  if (regex?.test(value) === false) {
    addError(
      state,
      "invalid-value",
      `String must match pattern ${JSON.stringify(state.schema.pattern)}`,
    );
  }
}

function countCodePoints(value: string): number {
  let length = 0;
  for (const _codePoint of value) length++;
  return length;
}

function validateNumberConstraints(state: ValidationState): void {
  const value = state.value;
  if (typeof value !== "number") return;
  addBoundedError(state, "minimum", value, state.schema.minimum, ">=");
  addBoundedError(state, "maximum", value, state.schema.maximum, "<=");
  addBoundedError(
    state,
    "exclusiveMinimum",
    value,
    state.schema.exclusiveMinimum,
    ">",
  );
  addBoundedError(
    state,
    "exclusiveMaximum",
    value,
    state.schema.exclusiveMaximum,
    "<",
  );
  validateMultipleOf(state, value);
}

function validateMultipleOf(state: ValidationState, value: number): void {
  const divisor = state.schema.multipleOf;
  if (divisor === undefined) return;
  if (!Number.isFinite(divisor) || divisor <= 0) {
    addError(state, "invalid-schema", "multipleOf must be positive and finite");
    return;
  }
  if (!isExactMultiple(value, divisor)) {
    addError(
      state,
      "invalid-value",
      `Number must be a multiple of ${String(divisor)}`,
    );
  }
}

function isExactMultiple(value: number, divisor: number): boolean {
  const left = toDecimalNumber(value);
  const right = toDecimalNumber(divisor);
  if (left === undefined || right === undefined) return false;
  const scale = Math.max(left.scale, right.scale);
  const dividend = scaleCoefficient(left, scale);
  const divisorCoefficient = scaleCoefficient(right, scale);
  return dividend % divisorCoefficient === 0n;
}

function scaleCoefficient(value: DecimalNumber, scale: number): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

function toDecimalNumber(value: number): DecimalNumber | undefined {
  if (!Number.isFinite(value)) return undefined;
  const match = DECIMAL_PATTERN.exec(String(value));
  if (match === null) return undefined;
  const sign = match[1] === "-" ? -1n : 1n;
  const integer = match[2];
  if (integer === undefined) return undefined;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  let coefficient = sign * BigInt(`${integer}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return normalizeDecimal({ coefficient, scale });
}

function normalizeDecimal(value: DecimalNumber): DecimalNumber {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale--;
  }
  return { coefficient, scale };
}
