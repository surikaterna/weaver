import { consoleLogger } from "@weaver-conf/config-engine";
import {
  type AuthorizationRequest,
  type ConfigurationAuthorityAuditRecord,
  configurationAuthorityAuditRecordSchema,
  createWeaverError,
  type TrustedPrincipalSnapshot,
} from "@weaver-conf/config-types";
import type { RootState } from "../root-state";

export function invokeWriteHook<T>(state: RootState, hook: () => T): T {
  if (state.writeHookActive)
    throw createWeaverError("FORBIDDEN", "Authority callback reentry denied");
  state.writeHookActive = true;
  try {
    return hook();
  } finally {
    state.writeHookActive = false;
  }
}
export async function auditWrite(
  state: RootState,
  ticket: {
    readonly principal: TrustedPrincipalSnapshot;
    readonly request: AuthorizationRequest;
    readonly commandIndex?: number;
  },
  phase: ConfigurationAuthorityAuditRecord["phase"],
): Promise<void> {
  const audit = state.factory.host.audit;
  if (!audit) return;
  try {
    const record = configurationAuthorityAuditRecordSchema.parse({
      principalId: ticket.principal.principalId,
      request: ticket.request,
      phase,
      ...(ticket.commandIndex === undefined
        ? {}
        : { commandIndex: ticket.commandIndex }),
    });
    await invokeWriteHook(state, () => audit(record));
  } catch {
    try {
      consoleLogger.error("[audit] configuration audit failed");
    } catch {
      /* Diagnostic failures cannot replace the operation outcome. */
    }
  }
}
