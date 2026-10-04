import { createWeaverError } from "@weaver-conf/config-types";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Only schema positions are traversed, never example/default/const values. */
export function rejectCeilings(schema: unknown): void {
  const pending: unknown[] = [schema];
  const seen = new Set<object>();
  while (pending.length) {
    const node = pending.pop();
    if (!record(node) || seen.has(node)) continue;
    seen.add(node);
    const metadata = node["x-weaver"];
    if (record(metadata) && Object.hasOwn(metadata, "maxOverrideLayer"))
      throw createWeaverError(
        "UNSUPPORTED_OPERATION",
        "Override ceilings are not supported by this factory",
      );
    for (const key of ["properties", "patternProperties"]) {
      const map = node[key];
      if (record(map)) pending.push(...Object.values(map));
    }
    for (const key of ["additionalProperties", "not"]) pending.push(node[key]);
    for (const key of ["items", "allOf", "anyOf", "oneOf"]) {
      const value = node[key];
      if (Array.isArray(value)) pending.push(...value);
      else pending.push(value);
    }
  }
}
