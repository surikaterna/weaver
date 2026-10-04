import {
  createWeaverError,
  type HydratedConfigurationReader,
} from "@weaver-conf/config-types";
import type { IdentitySnapshot } from "./identity-snapshots";
import type { createServiceEvents } from "./service-events";

export function createSnapshotReader(
  snapshot: () => IdentitySnapshot,
  assertLive: () => void,
  events: ReturnType<typeof createServiceEvents>,
  gate: (
    path: string,
    operation: "read" | "inspect",
    layer?: string,
    aggregate?: boolean,
  ) => void = () => {},
): HydratedConfigurationReader {
  const current = () => {
    assertLive();
    return snapshot();
  };
  return {
    ...valueMethods(current, gate),
    get identity() {
      return current().identity;
    },
    get revision() {
      return current().revision;
    },
    get mode() {
      return current().degradedProviders.length ? "degraded" : "live";
    },
    get degradedProviders() {
      return current().degradedProviders;
    },
    onChange(path, listener) {
      assertLive();
      gate(path, "read");
      current().projection.get(path);
      if (typeof listener !== "function")
        throw createWeaverError("VALIDATION_ERROR", "Invalid change listener");
      return events.subscribe(path, listener);
    },
  };
}

function valueMethods(
  current: () => IdentitySnapshot,
  gate: (
    path: string,
    operation: "read" | "inspect",
    layer?: string,
    aggregate?: boolean,
  ) => void,
): Pick<
  HydratedConfigurationReader,
  "get" | "getWithDefault" | "getAtLayer" | "getNamespace" | "inspect"
> {
  return {
    get(path) {
      const snapshot = current();
      gate(path, "read");
      return snapshot.projection.get(path);
    },
    getWithDefault(path, defaultValue) {
      const snapshot = current();
      gate(path, "read");
      const value = snapshot.projection.get(path);
      return value === undefined ? defaultValue : value;
    },
    getAtLayer(layer, path) {
      const snapshot = current();
      gate(path, "read", layer);
      return snapshot.projection.getAtLayer(layer, path);
    },
    getNamespace(prefix) {
      const snapshot = current();
      gate(prefix, "read", undefined, true);
      return snapshot.projection.getNamespace(prefix);
    },
    inspect(path) {
      const snapshot = current();
      gate(path, "inspect");
      return snapshot.projection.inspect(path);
    },
  };
}
