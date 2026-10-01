import type { ConfigMount } from "@weaver-conf/config-types";
import { z } from "zod";
import { copySnapshotData } from "./descriptor-copy";
import { parsePath } from "./path";
import { ownMount, ownPath } from "./projection-data";
import { isProtectedConfigPath } from "./protected-config-paths";

export interface MountSourceClassifier {
  readonly isTainted: (mount: ConfigMount) => boolean;
}

// Package-private callable shape only; it cannot authenticate source policy.
export const mountSourceClassifierSchema: z.ZodType<MountSourceClassifier> =
  z.strictObject({
    isTainted: z.custom<MountSourceClassifier["isTainted"]>(
      (value) => typeof value === "function",
    ),
  });

export function createMountSourceClassifier(
  state: Readonly<Record<string, unknown>>,
  sourceIsForbidden: (segments: readonly string[]) => boolean,
  cycleIsForbidden: boolean,
): MountSourceClassifier {
  const memo = new Map<string, boolean>();
  return Object.freeze({
    isTainted: (mount: ConfigMount) => {
      const safe = ownMount(copySnapshotData(mount));
      if (!safe) return cycleIsForbidden;
      const source = safe.source;
      return classifySource(
        source,
        state,
        sourceIsForbidden,
        cycleIsForbidden,
        memo,
      );
    },
  });
}

function classifySource(
  source: string,
  state: Readonly<Record<string, unknown>>,
  forbidden: (segments: readonly string[]) => boolean,
  cycles: boolean,
  memo: Map<string, boolean>,
): boolean {
  const local = new Set<string>();
  let current = source;
  let terminal = false;
  while (true) {
    if (isProtectedConfigPath(current)) {
      terminal = true;
      break;
    }
    const cached = memo.get(current);
    if (cached !== undefined) {
      terminal = cached;
      break;
    }
    if (local.has(current)) {
      terminal = cycles;
      break;
    }
    local.add(current);
    const step = sourceStep(current, state, forbidden, cycles);
    if (typeof step === "boolean") {
      terminal = step;
      break;
    }
    current = step;
  }
  for (const path of local) memo.set(path, terminal);
  return terminal;
}

function sourceStep(
  source: string,
  state: Readonly<Record<string, unknown>>,
  forbidden: (segments: readonly string[]) => boolean,
  invalid: boolean,
): string | boolean {
  let segments: readonly string[];
  try {
    segments = parsePath(source);
  } catch {
    return invalid;
  }
  if (forbidden(segments)) return true;
  return ownMount(ownPath(state, segments))?.source ?? false;
}
