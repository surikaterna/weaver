import type { LoadedContribution } from "../hydration";
import type { RootState } from "../root-state";

export function fenceWrites(
  state: RootState,
  targets: readonly LoadedContribution[],
): void {
  state.writeFence = Object.freeze([
    ...new Set([
      ...(state.writeFence ?? []),
      ...targets.map((target) => target.selection.captured.binding.id),
    ]),
  ]);
}
