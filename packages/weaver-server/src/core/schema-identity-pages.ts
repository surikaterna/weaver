import { randomBytes } from "node:crypto";
import type {
  RegisteredSchemaIdentityPageRequest,
  RegisteredSchemaIdentityPageResponse,
} from "@weaver-conf/config-types";
import { registeredSchemaIdentityPageRequestSchema } from "@weaver-conf/config-types";
import { createWeaverError } from "../types/errors";
import type { RegistryState } from "./schema-registry-state";

type IdentityRef =
  | {
      readonly kind: "service" | "fragment";
      readonly path: string;
      readonly environment: string;
    }
  | {
      readonly kind: "slot";
      readonly path: string;
      readonly environment: string;
      readonly accepts: "object";
    };

const cursorBytes = 41;
const safe = BigInt(Number.MAX_SAFE_INTEGER);

function invalid(message: string): never {
  throw createWeaverError("VALIDATION_ERROR", message);
}

function compare(a: IdentityRef, b: IdentityRef): number {
  for (const field of ["environment", "path", "kind"] as const) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  return 0;
}

export function buildIdentityIndex(
  state: RegistryState,
): ReadonlyArray<IdentityRef> {
  const refs: IdentityRef[] = [];
  for (const { kind, path, environment } of state.schemas.values())
    refs.push({ kind, path, environment });
  for (const {
    canonicalSlotPath,
    environment,
    accepts,
  } of state.slots.values())
    refs.push({ kind: "slot", path: canonicalSlotPath, environment, accepts });
  return refs.sort(compare);
}

function decode(cursor: string): {
  instance: Buffer;
  revision: number;
  limit: number;
  offset: number;
} {
  if (!/^[A-Za-z0-9_-]{55}$/.test(cursor))
    invalid("Invalid identity page cursor");
  const bytes = Buffer.from(cursor, "base64url");
  if (
    bytes.length !== cursorBytes ||
    bytes.toString("base64url") !== cursor ||
    bytes[0] !== 1
  )
    invalid("Invalid identity page cursor");
  const numbers = [17, 25, 33].map((position) =>
    bytes.readBigUInt64BE(position),
  );
  if (numbers.some((value) => value > safe))
    invalid("Invalid identity page cursor");
  return {
    instance: bytes.subarray(1, 17),
    revision: Number(numbers[0]),
    limit: Number(numbers[1]),
    offset: Number(numbers[2]),
  };
}

function encode(
  instance: Buffer,
  revision: number,
  limit: number,
  offset: number,
): string {
  const bytes = Buffer.alloc(cursorBytes);
  bytes[0] = 1;
  instance.copy(bytes, 1);
  bytes.writeBigUInt64BE(BigInt(revision), 17);
  bytes.writeBigUInt64BE(BigInt(limit), 25);
  bytes.writeBigUInt64BE(BigInt(offset), 33);
  return bytes.toString("base64url");
}

export class SchemaIdentityPages {
  private readonly instance = randomBytes(16);
  private revision = 0;
  private index: ReadonlyArray<IdentityRef>;

  constructor(
    state: RegistryState,
    readonly maxPageSize: number,
  ) {
    this.index = buildIdentityIndex(state);
  }

  publish(index: ReadonlyArray<IdentityRef>): void {
    this.assertCanPublish();
    this.index = index;
    this.revision++;
  }

  assertCanPublish(): void {
    if (this.revision === Number.MAX_SAFE_INTEGER)
      throw createWeaverError("INTERNAL_ERROR", "Identity revision exhausted");
  }

  page(
    input: RegisteredSchemaIdentityPageRequest = {},
  ): RegisteredSchemaIdentityPageResponse {
    const parsed = registeredSchemaIdentityPageRequestSchema.safeParse(input);
    if (!parsed.success) invalid("Invalid identity page request");
    const cursor = parsed.data.cursor ? decode(parsed.data.cursor) : null;
    const limit = parsed.data.limit ?? cursor?.limit ?? 50;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > this.maxPageSize ||
      (cursor && (cursor.limit !== limit || cursor.limit < 1))
    )
      invalid("Invalid identity page limit");
    if (
      cursor &&
      (!cursor.instance.equals(this.instance) ||
        cursor.revision !== this.revision)
    )
      throw createWeaverError(
        "REVISION_CONFLICT",
        "Identity page cursor is stale",
      );
    const offset = cursor?.offset ?? 0;
    if (cursor && (offset < 1 || offset >= this.index.length))
      invalid("Invalid identity page offset");
    const end = offset + Math.min(limit, this.index.length - offset);
    const anchors: Extract<IdentityRef, { kind: "service" | "fragment" }>[] =
      [];
    const slots: Extract<IdentityRef, { kind: "slot" }>[] = [];
    for (const ref of this.index.slice(offset, end)) {
      if (ref.kind === "slot") slots.push(ref);
      else anchors.push(ref);
    }
    const nextCursor =
      end < this.index.length
        ? encode(this.instance, this.revision, limit, end)
        : null;
    return { anchors, slots, nextCursor, hasMore: nextCursor !== null };
  }
}
