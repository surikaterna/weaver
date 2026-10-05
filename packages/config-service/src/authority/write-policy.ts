import type { AuthFunctions } from "@weaver-conf/config-auth";
import { parseCanonicalConfigPath } from "@weaver-conf/config-engine";
import { evaluateChangePolicy } from "@weaver-conf/config-policy/browser";
import {
  type AuthorizationRequest,
  createWeaverError,
  type TrustedPrincipalSnapshot,
} from "@weaver-conf/config-types";
import type { IdentitySnapshot } from "../identity-snapshots";
import type { RootState } from "../root-state";
import { writeAncestors } from "./authority-leaf";

export function admitWritePolicy(
  state: RootState,
  principal: TrustedPrincipalSnapshot,
  request: AuthorizationRequest,
  auth: AuthFunctions,
  layer: string,
): void {
  if (
    principal.session ||
    state.factory.host.authConfig?.sessionLayer === layer
  )
    throw createWeaverError(
      "POLICY_VIOLATION",
      "Session writes are unsupported",
    );
  const access = { userId: principal.principalId, roles: principal.roles };
  for (const schema of writeAncestors(state.factory.registry, request)) {
    if (!auth.canRead(access, request.path, schema))
      throw createWeaverError("FORBIDDEN", "Configuration authority denied");
    if (
      evaluateChangePolicy(schema, access, layer, auth.canWrite).outcome !==
      "allowed"
    )
      throw createWeaverError(
        "POLICY_VIOLATION",
        "Configuration write policy denied",
      );
  }
}
export function checkProjection(
  snapshot: IdentitySnapshot,
  path: AuthorizationRequest["path"],
): void {
  const inspected = snapshot.projection.inspect(path);
  if (
    inspected.effective.state === "redacted" ||
    inspected.contributions.some((item) => item.state === "redacted")
  )
    throw createWeaverError("FORBIDDEN", "Configuration authority denied");
}
export function rejectAtomicAncestors(
  entries: Readonly<Record<string, unknown>>,
  path: string,
): void {
  let current: unknown = entries;
  for (const part of parseCanonicalConfigPath(path).segments.slice(0, -1)) {
    if (current === undefined) return;
    if (!isRecord(current)) unsupported();
    current = Object.hasOwn(current, part) ? current[part] : undefined;
    if (current !== undefined && !isRecord(current)) unsupported();
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function unsupported(): never {
  throw createWeaverError(
    "UNSUPPORTED_OPERATION",
    "Atomic ancestor replacement is unsupported",
  );
}
