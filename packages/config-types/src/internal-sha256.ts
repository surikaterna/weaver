const constants = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;
const initial = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
] as const;

/** Dependency-free synchronous SHA-256 for canonical serialized contract identities. */
export function sha256Hex(text: string): string {
  const bytes = paddedBytes(new TextEncoder().encode(text));
  const hash = [...initial];
  for (let offset = 0; offset < bytes.length; offset += 64)
    compress(hash, bytes, offset);
  return hash
    .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

function paddedBytes(input: Uint8Array): Uint8Array {
  const length = Math.ceil((input.length + 9) / 64) * 64;
  const result = new Uint8Array(length);
  result.set(input);
  result[input.length] = 0x80;
  const bits = BigInt(input.length) * 8n;
  for (let index = 0; index < 8; index++)
    result[length - 1 - index] = Number((bits >> BigInt(index * 8)) & 0xffn);
  return result;
}

function compress(hash: number[], bytes: Uint8Array, offset: number): void {
  const words = schedule(bytes, offset);
  let a = hash[0] ?? 0;
  let b = hash[1] ?? 0;
  let c = hash[2] ?? 0;
  let d = hash[3] ?? 0;
  let e = hash[4] ?? 0;
  let f = hash[5] ?? 0;
  let g = hash[6] ?? 0;
  let h = hash[7] ?? 0;
  for (let index = 0; index < 64; index++) {
    const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
    const choice = (e & f) ^ (~e & g);
    const first =
      (h + s1 + choice + (constants[index] ?? 0) + (words[index] ?? 0)) | 0;
    const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    [a, b, c, d, e, f, g, h] = [
      (first + s0 + majority) | 0,
      a,
      b,
      c,
      (d + first) | 0,
      e,
      f,
      g,
    ];
  }
  for (const [index, word] of [a, b, c, d, e, f, g, h].entries())
    hash[index] = ((hash[index] ?? 0) + word) | 0;
}

function schedule(bytes: Uint8Array, offset: number): number[] {
  const words = new Array<number>(64).fill(0);
  for (let index = 0; index < 16; index++) {
    const start = offset + index * 4;
    words[index] =
      ((bytes[start] ?? 0) << 24) |
      ((bytes[start + 1] ?? 0) << 16) |
      ((bytes[start + 2] ?? 0) << 8) |
      (bytes[start + 3] ?? 0);
  }
  for (let index = 16; index < 64; index++) {
    const x = words[index - 15] ?? 0;
    const y = words[index - 2] ?? 0;
    const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
    const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
    words[index] =
      ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) | 0;
  }
  return words;
}

function rotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
