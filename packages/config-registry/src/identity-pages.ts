import type {
  RegisteredSchemaIdentityPageRequest,
  RegisteredSchemaIdentityPageResponse,
} from "@weaver-conf/config-types";
import {
  createWeaverError,
  registeredSchemaIdentityPageRequestSchema,
} from "@weaver-conf/config-types";
import {
  createInstanceIdentity,
  decodeCursor,
  encodeCursor,
  type IdentityCursor,
  invalid,
} from "./identity-cursor";
import { buildIdentityIndex, type IdentityRef } from "./identity-index";
import type { RegistryState } from "./registry-state";

export class SchemaIdentityPages {
  private readonly instance: Uint8Array;
  private revision = 0;
  private index: ReadonlyArray<IdentityRef>;

  constructor(
    state: RegistryState,
    readonly maxPageSize: number,
    entropy = createInstanceIdentity,
  ) {
    this.instance = entropy().slice();
    if (this.instance.length !== 16) invalid("Invalid identity instance");
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
    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
    const limit = parsed.data.limit ?? cursor?.limit ?? 50;
    this.validateCursor(cursor, limit);
    const offset = cursor?.offset ?? 0;
    const end = offset + Math.min(limit, this.index.length - offset);
    const { anchors, slots } = partition(this.index.slice(offset, end));
    const nextCursor =
      end < this.index.length
        ? encodeCursor(this.instance, this.revision, limit, end)
        : null;
    return { anchors, slots, nextCursor, hasMore: nextCursor !== null };
  }

  private validateCursor(cursor: IdentityCursor | null, limit: number): void {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > this.maxPageSize ||
      (cursor && (cursor.limit !== limit || cursor.limit < 1))
    )
      invalid("Invalid identity page limit");
    if (
      cursor &&
      (!cursor.instance.every(
        (value, position) => value === this.instance[position],
      ) ||
        cursor.revision !== this.revision)
    ) {
      throw createWeaverError(
        "REVISION_CONFLICT",
        "Identity page cursor is stale",
      );
    }
    if (cursor && (cursor.offset < 1 || cursor.offset >= this.index.length))
      invalid("Invalid identity page offset");
  }
}

function partition(
  refs: ReadonlyArray<IdentityRef>,
): Pick<RegisteredSchemaIdentityPageResponse, "anchors" | "slots"> {
  const anchors: RegisteredSchemaIdentityPageResponse["anchors"][number][] = [];
  const slots: RegisteredSchemaIdentityPageResponse["slots"][number][] = [];
  for (const ref of refs) {
    if (ref.kind === "slot") slots.push({ ...ref });
    else anchors.push({ ...ref });
  }
  return { anchors, slots };
}
