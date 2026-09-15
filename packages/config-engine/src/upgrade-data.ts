import { createHash } from "node:crypto";
import {
  canonicalInternalJson,
  type InternalUpgradeContentDomain,
  type InternalUpgradePlannerInput,
  type ScopeInstance,
} from "@weaver-conf/config-types";
import { deepMerge } from "./merge";

export function upgradeLayerContentDomain(
  entries: Readonly<Record<string, unknown>>,
): InternalUpgradeContentDomain {
  return Object.hasOwn(entries, "_weaver")
    ? "control-application-v1"
    : "layer-entries-v1";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function digestValue(value: unknown, absent = false): string {
  const body = absent ? { absent: true } : { absent: false, value };
  return createHash("sha256").update(canonicalInternalJson(body)).digest("hex");
}

export function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

export function hasOwnPath(value: unknown, path: readonly string[]): boolean {
  if (!path.length) return value !== undefined;
  let current = value;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

export function setOwnPath(
  value: Record<string, unknown>,
  path: readonly string[],
  child: unknown,
): boolean {
  let current = value;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (!isRecord(next)) return false;
    current = next;
  }
  const key = path.at(-1);
  if (key === undefined) return false;
  current[key] = structuredClone(child);
  return true;
}

export function mergeEntries(
  layers: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  for (const layer of layers)
    result = deepMerge(
      result,
      structuredClone(Object.fromEntries(Object.entries(layer))),
    );
  return result;
}

export function replaceAtPath(
  entries: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): boolean {
  if (path.length === 0) return false;
  let current = entries;
  for (const key of path.slice(0, -1)) {
    const child = current[key];
    if (child === undefined) {
      const created: Record<string, unknown> = {};
      current[key] = created;
      current = created;
      continue;
    }
    if (!isRecord(child)) return false;
    current = child;
  }
  const leaf = path.at(-1);
  if (leaf === undefined) return false;
  current[leaf] = structuredClone(value);
  return true;
}

export function canonicalUpgradeContexts(
  input: InternalUpgradePlannerInput,
): readonly (readonly ScopeInstance[])[] {
  return [
    [],
    ...Object.values(input.inventory.contexts).map((entry) => entry.scopePath),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function upgradePathSegments(path: string): readonly string[] {
  return path.slice(1).split("/");
}
