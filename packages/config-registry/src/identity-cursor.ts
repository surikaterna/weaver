import { createWeaverError } from "@weaver-conf/config-types";

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const cursorBytes = 41;
const safe = BigInt(Number.MAX_SAFE_INTEGER);

export interface IdentityCursor {
  readonly instance: Uint8Array;
  readonly revision: number;
  readonly limit: number;
  readonly offset: number;
}

export function invalid(message: string): never {
  throw createWeaverError("VALIDATION_ERROR", message);
}

function base64url(bytes: Uint8Array): string {
  let result = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      result += alphabet[(value >>> bits) & 63];
    }
  }
  if (bits > 0) result += alphabet[(value << (6 - bits)) & 63];
  return result;
}

function parseBase64url(cursor: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{55}$/.test(cursor))
    invalid("Invalid identity page cursor");
  const bytes = new Uint8Array(cursorBytes);
  let bits = 0;
  let value = 0;
  let offset = 0;
  for (const char of cursor) {
    value = (value << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    bytes[offset++] = (value >>> bits) & 255;
  }
  if (base64url(bytes) !== cursor || bytes[0] !== 1)
    invalid("Invalid identity page cursor");
  return bytes;
}

export function decodeCursor(cursor: string): IdentityCursor {
  const bytes = parseBase64url(cursor);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numbers = [17, 25, 33].map((position) => view.getBigUint64(position));
  if (numbers.some((value) => value > safe))
    invalid("Invalid identity page cursor");
  return {
    instance: bytes.slice(1, 17),
    revision: Number(numbers[0]),
    limit: Number(numbers[1]),
    offset: Number(numbers[2]),
  };
}

export function encodeCursor(
  instance: Uint8Array,
  revision: number,
  limit: number,
  offset: number,
): string {
  if (
    instance.length !== 16 ||
    [revision, limit, offset].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  )
    invalid("Invalid identity page cursor");
  const bytes = new Uint8Array(cursorBytes);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes.set(instance, 1);
  view.setBigUint64(17, BigInt(revision));
  view.setBigUint64(25, BigInt(limit));
  view.setBigUint64(33, BigInt(offset));
  return base64url(bytes);
}

export function createInstanceIdentity(): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw createWeaverError(
      "INTERNAL_ERROR",
      "Web Crypto is required for schema identity pages",
    );
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(16));
}
