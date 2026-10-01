import type { ConfigMount } from "@weaver-conf/config-types";
import { ownDataValue } from "./own-data";

export function ownMount(value: unknown): ConfigMount | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (ownDataValue(value, "_weaver") !== "mount") return undefined;
  const source = ownDataValue(value, "source");
  return typeof source === "string" ? { _weaver: "mount", source } : undefined;
}

export function ownPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = ownDataValue(current, key);
  }
  return current;
}
