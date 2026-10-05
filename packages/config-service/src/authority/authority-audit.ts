import { consoleLogger } from "@weaver-conf/config-engine";
import {
  type ConfigurationAuthorityAuditRecord,
  configurationAuthorityAuditRecordSchema,
  createWeaverError,
} from "@weaver-conf/config-types";
import type { RootState } from "../root-state";
import type { WriteTicket } from "./authority-write";

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
  ticket: WriteTicket,
  phase: ConfigurationAuthorityAuditRecord["phase"],
): Promise<void> {
  const audit = state.factory.host.audit;
  if (!audit) return;
  try {
    const record = configurationAuthorityAuditRecordSchema.parse({
      principalId: ticket.principal.principalId,
      request: ticket.request,
      phase,
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
