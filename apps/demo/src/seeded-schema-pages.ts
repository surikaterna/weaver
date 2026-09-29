import {
  createWeaverError,
  type RegisteredSchemaIdentityListResponse,
  type RegisteredSchemaIdentityPageRequest,
  type RegisteredSchemaIdentityPageResponse,
  registeredSchemaIdentityPageRequestSchema,
  registeredSchemaIdentityPageResponseSchema,
} from "@weaver-conf/config-types";

type Anchor = RegisteredSchemaIdentityListResponse["anchors"][number];
type Slot = RegisteredSchemaIdentityListResponse["slots"][number];
type Identity = Anchor | Slot;
const invalid = (message = "Invalid identity page cursor"): never => {
  throw createWeaverError("VALIDATION_ERROR", message);
};

function compare(a: Identity, b: Identity): number {
  for (const field of ["environment", "path", "kind"] as const) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  return 0;
}

function encode(
  instance: Uint8Array,
  revision: number,
  limit: number,
  offset: number,
): string {
  const bytes = new Uint8Array(41);
  bytes[0] = 1;
  bytes.set(instance, 1);
  const view = new DataView(bytes.buffer);
  for (const [position, number] of [
    [17, revision],
    [25, limit],
    [33, offset],
  ] as const)
    view.setBigUint64(position, BigInt(number));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decode(cursor: string): {
  instance: Uint8Array;
  revision: number;
  limit: number;
  offset: number;
} {
  if (!/^[A-Za-z0-9_-]{55}$/.test(cursor)) invalid();
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(
      atob(cursor.replace(/-/g, "+").replace(/_/g, "/")),
      (char) => char.charCodeAt(0),
    );
  } catch {
    return invalid();
  }
  if (
    bytes.length !== 41 ||
    bytes[0] !== 1 ||
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "") !== cursor
  )
    invalid();
  const view = new DataView(bytes.buffer);
  const numbers = [17, 25, 33].map((position) => view.getBigUint64(position));
  if (numbers.some((value) => value > BigInt(Number.MAX_SAFE_INTEGER)))
    invalid();
  return {
    instance: bytes.slice(1, 17),
    revision: Number(numbers[0]),
    limit: Number(numbers[1]),
    offset: Number(numbers[2]),
  };
}

export function createSeededSchemaPages(
  seed: RegisteredSchemaIdentityListResponse,
  maxPageSize = 200,
) {
  const instance = crypto.getRandomValues(new Uint8Array(16));
  let revision = 0;
  let index: ReadonlyArray<Identity> = [];
  function publish(list: RegisteredSchemaIdentityListResponse): void {
    if (revision === Number.MAX_SAFE_INTEGER)
      throw createWeaverError("INTERNAL_ERROR", "Identity revision exhausted");
    index = [...list.anchors, ...list.slots].sort(compare);
    revision++;
  }
  publish(seed);
  function page(
    input: RegisteredSchemaIdentityPageRequest = {},
  ): RegisteredSchemaIdentityPageResponse {
    const parsed = registeredSchemaIdentityPageRequestSchema.safeParse(input);
    if (!parsed.success || !parsed.data)
      return invalid("Invalid identity page request");
    const cursor = parsed.data.cursor ? decode(parsed.data.cursor) : null;
    const limit = parsed.data.limit ?? cursor?.limit ?? 50;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > maxPageSize ||
      (cursor && (cursor.limit !== limit || cursor.limit < 1))
    )
      invalid("Invalid identity page limit");
    if (
      cursor &&
      (!cursor.instance.every((byte, i) => byte === instance[i]) ||
        cursor.revision !== revision)
    )
      throw createWeaverError(
        "REVISION_CONFLICT",
        "Identity page cursor is stale",
      );
    const offset = cursor?.offset ?? 0;
    if (cursor && (offset < 1 || offset >= index.length))
      invalid("Invalid identity page offset");
    const end = offset + Math.min(limit, index.length - offset);
    const anchors: Anchor[] = [];
    const slots: Slot[] = [];
    for (const identity of index.slice(offset, end)) {
      if (identity.kind === "slot") slots.push(identity);
      else anchors.push(identity);
    }
    const nextCursor =
      end < index.length ? encode(instance, revision, limit, end) : null;
    return registeredSchemaIdentityPageResponseSchema.parse({
      anchors,
      slots,
      nextCursor,
      hasMore: nextCursor !== null,
    });
  }
  return { page, publish };
}
