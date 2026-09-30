import type { RegisteredSchemaIdentityPageResponse } from "@weaver-conf/config-types";
import type { RegistryState } from "./registry-state";

export type IdentityRef =
  | RegisteredSchemaIdentityPageResponse["anchors"][number]
  | RegisteredSchemaIdentityPageResponse["slots"][number];

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
