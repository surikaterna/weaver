import { projectConfigurationData } from "@weaver-conf/config-engine";

/** Reuse the engine's descriptor-first detached frozen data capture, not a resolver. */
export function copyData(value: unknown): unknown {
  return projectConfigurationData(
    value,
    {},
    { decide: () => "retain", child: (context) => context },
  );
}
