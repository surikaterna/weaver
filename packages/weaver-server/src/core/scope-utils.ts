import type { ScopeInstance } from "@weaver-conf/config-types";
import { formatScopePath } from "@weaver-conf/config-types";

export interface ParsedScopeLayer {
  scopeId: string;
  value: string;
}

export function parseScopeLayer(layer: string): ParsedScopeLayer | null {
  const colonIdx = layer.indexOf(":");
  if (colonIdx <= 0 || colonIdx === layer.length - 1) return null;

  const scopeId = layer.slice(0, colonIdx);
  const value = layer.slice(colonIdx + 1);
  if (!scopeId || !value) return null;

  return {
    scopeId,
    value,
  };
}

export function isScopedLayer(layer: string): boolean {
  return parseScopeLayer(layer) !== null;
}

export function isSameScopeLayer(left: string, right: string): boolean {
  const leftScope = parseScopeLayer(left);
  const rightScope = parseScopeLayer(right);
  if (!leftScope || !rightScope) return false;
  return (
    leftScope.scopeId === rightScope.scopeId &&
    leftScope.value === rightScope.value
  );
}

export function formatColonScopeLayer(scopeId: string, value: string): string {
  return `${scopeId}:${value}`;
}

export function normalizeScopeLayer(layer: string): string {
  const parsed = parseScopeLayer(layer);
  if (!parsed) return layer;
  return formatColonScopeLayer(parsed.scopeId, parsed.value);
}

export function buildScopePathString(scopePath: ScopeInstance[]): string {
  return formatScopePath(scopePath);
}

export function parseScopeQuery(
  query: string | undefined,
): ScopeInstance[] | undefined {
  if (!query) return undefined;
  return query.split(/[/,]/).map((part) => {
    const [scopeId = "", value = ""] = part.split(":");
    return { scopeId, value };
  });
}
