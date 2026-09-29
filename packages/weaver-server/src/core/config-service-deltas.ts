import type { ScopeInstance } from "@weaver-conf/config-types";
import type { ConfigDelta } from "../types/index";
import { publicConfigView } from "./public-config-inspection";
import { parseScopeLayer } from "./scope-utils";

export function createPublicDeltaEmitter(
  getMergedState: (scopePath?: ScopeInstance[]) => Record<string, unknown>,
  getBaseEntries: () => Record<string, unknown>,
  handlers: ReadonlySet<(delta: ConfigDelta) => void>,
): (delta: ConfigDelta) => void {
  return (delta) => {
    const scope = parseScopeLayer(delta.layer);
    const state = scope ? getMergedState([scope]) : getBaseEntries();
    const publicDelta = publicConfigView.delta(delta, state);
    if (!publicDelta) return;
    for (const handler of handlers) handler(publicDelta);
  };
}
