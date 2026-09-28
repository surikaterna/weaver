import type { ConfigDelta } from "@weaver-conf/config-types";
import type { LocalTransport } from "@weaver-conf/weaver-client";
import { createLocalTransport } from "@weaver-conf/weaver-client";
import { SEED_SNAPSHOT } from "./seed-data";

/** Local writes do not publish deltas; bridge them for the demo's live client. */
export function bridgeLocalWrites(transport: LocalTransport): LocalTransport {
  const set = transport.set.bind(transport);
  const remove = transport.remove.bind(transport);

  function publish(delta: ConfigDelta): void {
    transport.pushDelta(delta);
  }

  return {
    ...transport,
    async set(key, value, options) {
      const result = await set(key, value, options);
      if (result.success) {
        publish({
          action: "set",
          key,
          value,
          layer: options?.layer ?? "user",
          environment: options?.environment ?? "default",
          timestamp: new Date().toISOString(),
        });
      }
      return result;
    },
    async remove(key, options) {
      const result = await remove(key, options);
      if (result.success) {
        publish({
          action: "remove",
          key,
          value: null,
          layer: options?.layer ?? "user",
          environment: options?.environment ?? "default",
          timestamp: new Date().toISOString(),
        });
      }
      return result;
    },
  };
}

export function createDemoTransport(): LocalTransport {
  return bridgeLocalWrites(
    createLocalTransport({ snapshot: structuredClone(SEED_SNAPSHOT) }),
  );
}
