import type { InternalConfiguration } from "@weaver-conf/config-types";
import type { ValidatedCandidate } from "./config-pipeline";
import type { ConfigServiceController } from "./config-service-controller";

const contexts = new WeakMap<ConfigServiceController, InternalConfiguration>();

export function bindPinnedRecoveryContext(
  host: ConfigServiceController,
  configuration: InternalConfiguration,
): void {
  contexts.set(host, structuredClone(configuration));
}

export function releasePinnedRecoveryContext(
  host: ConfigServiceController,
): void {
  contexts.delete(host);
}

export function pinnedRecoveryContext(
  host: ConfigServiceController,
): InternalConfiguration | undefined {
  const configuration = contexts.get(host);
  return configuration ? structuredClone(configuration) : undefined;
}

export function pinnedEntries(
  host: ConfigServiceController,
  provider: ConfigServiceController["providers"][number],
  entries: Record<string, unknown>,
  candidate: Record<string, unknown> | undefined,
  validation: ValidatedCandidate | undefined,
): Record<string, unknown> {
  if (!contexts.has(host) || provider !== host.pipeline.controlProvider)
    return entries;
  if (!validation) return candidate ?? entries;
  return {
    ...entries,
    _weaver: validation.prepared.configuration,
  };
}
