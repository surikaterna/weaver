import {
  createWeaverError,
  type ScopeInstance,
  type ScopeInventory,
  scopeInventorySchema,
} from "@weaver-conf/config-types";

export function scopeContextId(path: readonly ScopeInstance[]): string {
  return Buffer.from(
    JSON.stringify(path.map(({ scopeId, value }) => [scopeId, value])),
    "utf8",
  ).toString("hex");
}
export function scopeInventoryDigest(inventory: ScopeInventory): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        inventory.version,
        inventory.revision,
        Object.entries(inventory.contexts).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ]),
    )
    .digest("hex");
}

/** Validate complete full paths and prefixes; never infer a Cartesian product. */
export function validateScopeInventory(input: unknown): ScopeInventory {
  const parsed = scopeInventorySchema.safeParse(input);
  if (!parsed.success)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "An authoritative scope inventory is required",
    );
  for (const [id, context] of Object.entries(parsed.data.contexts)) {
    if (scopeContextId(context.scopePath) !== id)
      throw createWeaverError(
        "VALIDATION_ERROR",
        "Scope inventory identity mismatch",
      );
    const seen = new Set(context.scopePath.map((scope) => scope.scopeId));
    if (seen.size !== context.scopePath.length)
      throw createWeaverError("VALIDATION_ERROR", "Duplicate scope dimension");
    for (let length = 1; length < context.scopePath.length; length++) {
      const prefix =
        parsed.data.contexts[
          scopeContextId(context.scopePath.slice(0, length))
        ];
      if (!prefix || (context.state === "active" && prefix.state !== "active"))
        throw createWeaverError(
          "VALIDATION_ERROR",
          "Scope inventory is missing an active prefix",
        );
    }
  }
  return parsed.data;
}

export function assertInventoryContext(
  inventory: ScopeInventory,
  path?: readonly ScopeInstance[],
): void {
  if (!path?.length) return;
  if (inventory.contexts[scopeContextId(path)]?.state !== "active")
    throw createWeaverError(
      "SCOPE_NOT_FOUND",
      "Scope path is not active in the authoritative inventory",
    );
}

import { createHash } from "node:crypto";
import { deepEqual } from "@weaver-conf/config-engine";

export function assertInventoryTransition(
  before: ScopeInventory,
  after: ScopeInventory,
  draft: boolean,
): void {
  if (
    draft &&
    before.revision === "0" &&
    !Object.keys(before.contexts).length &&
    after.revision === "0"
  )
    return;
  if (deepEqual(before, after)) return;
  if (BigInt(after.revision) !== BigInt(before.revision) + 1n)
    throw createWeaverError(
      "REVISION_CONFLICT",
      "Inventory revisions advance once per transition",
    );
  if (
    Object.keys(before.contexts).some(
      (id) => !Object.hasOwn(after.contexts, id),
    )
  )
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Scope retirement must retain context records",
    );
  const changed = Object.keys(after.contexts).filter(
    (id) => !deepEqual(before.contexts[id], after.contexts[id]),
  );
  if (changed.length !== 1)
    throw createWeaverError(
      "VALIDATION_ERROR",
      "Ordinary scope operations change one context",
    );
}
