import type { ValidatedCandidate } from "./config-pipeline";
import type { ConfigServiceController } from "./config-service-controller";
import type { ValidatedFinalContexts } from "./final-context-evidence";

export function installUpgradeSnapshot(
  host: ConfigServiceController,
  snapshot: ValidatedFinalContexts,
  prepared: ValidatedCandidate["prepared"],
): void {
  const controlId = host.pipeline.controlProvider.id;
  for (const layer of snapshot.base)
    if (layer.id !== controlId)
      host.layerData.set(layer.id, structuredClone(layer.entries));
  host.dynamicScopeEntries.clear();
  for (const layer of snapshot.scoped)
    host.dynamicScopeEntries.set(layer.id, structuredClone(layer.entries));
  host.pipeline.install(prepared);
  const active = snapshot.contexts.filter(
    (context) =>
      context.scopePath.length === 0 ||
      prepared.configuration.scopeInventory.contexts[context.id]?.state ===
        "active",
  );
  host.runtime.installValidated(
    active.map((context) => ({
      scopePath: [...context.scopePath],
      entries: structuredClone(context.delivered),
    })),
  );
}
