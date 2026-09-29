import { deepGet, deepRemove, deepSet } from "@weaver-conf/config-engine";
import type { ConfigDelta, ConfigSnapshot } from "@weaver-conf/config-types";
import type {
  LocalTransport,
  WeaverTransport,
  WriteOptions,
} from "@weaver-conf/weaver-client";
import { createLocalTransport } from "@weaver-conf/weaver-client";
import {
  registeredSchemaFixtures,
  seededSchemaDetail,
  seededSchemaIdentities,
} from "./registered-schema-fixtures";
import { ALL_KEYS, APP_SEED, CORE_SEED, SEED_SNAPSHOT } from "./seed-data";
import { createSeededSchemaPages } from "./seeded-schema-pages";

type Layer = "core" | "app" | "user";
type Entries = Record<string, unknown>;
type Layers = Record<Layer, Entries>;

function winner(layers: Layers, key: string): Layer | undefined {
  for (const layer of ["user", "app", "core"] as const)
    if (deepGet(layers[layer], key) !== undefined) return layer;
  return undefined;
}

function validValue(key: string, value: unknown): boolean {
  const seed = deepGet(CORE_SEED, key);
  if (typeof value !== typeof seed) return false;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    const limits: Record<string, readonly [number, number]> = {
      "app.ui.font.size": [8, 32],
      "app.network.timeout.ms": [1000, 60000],
      "app.network.retry.count": [0, 10],
    };
    const range = limits[key];
    if (range && (value < range[0] || value > range[1])) return false;
  }
  if (key === "app.ui.theme")
    return (
      typeof value === "string" && ["light", "dark", "system"].includes(value)
    );
  if (key === "app.feature.notifications.frequency")
    return (
      typeof value === "string" &&
      ["realtime", "hourly", "daily", "weekly"].includes(value)
    );
  return true;
}

function validTarget(key: string, options?: WriteOptions): boolean {
  if (!ALL_KEYS.includes(key)) return false;
  if (!options) return true;
  return Object.keys(options).every((option) =>
    option === "layer"
      ? options.layer === "user"
      : option === "environment" && options.environment === "default",
  );
}

function rejected(message: string) {
  return { success: false, error: { code: "unsupported_demo_write", message } };
}

function updateEffective(
  key: string,
  layers: Layers,
  snapshot: ConfigSnapshot,
  local: LocalTransport,
): void {
  const layer = winner(layers, key);
  const value = layer ? deepGet(layers[layer], key) : null;
  if (layer) deepSet(snapshot.entries, key, value);
  else deepRemove(snapshot.entries, key);
  const delta: ConfigDelta = {
    action: layer ? "set" : "remove",
    key,
    value,
    layer: layer ?? "user",
    environment: "default",
    timestamp: new Date().toISOString(),
  };
  local.pushDelta(delta);
}

function writeMethods(
  layers: Layers,
  snapshot: ConfigSnapshot,
  local: LocalTransport,
): Pick<LocalTransport, "set" | "remove" | "setMany"> {
  return {
    async set(key, value, options) {
      if (!validTarget(key, options) || !validValue(key, value))
        return rejected("Only valid base user writes are supported");
      if (Object.is(deepGet(snapshot.entries, key), value))
        return rejected("Value is already effective");
      deepSet(layers.user, key, value);
      updateEffective(key, layers, snapshot, local);
      return { success: true, revision: `demo-${Date.now()}` };
    },
    async remove(key, options) {
      if (!validTarget(key, options))
        return rejected("Only base user removals are supported");
      if (deepGet(layers.user, key) === undefined)
        return rejected("No user override exists");
      deepRemove(layers.user, key);
      updateEffective(key, layers, snapshot, local);
      return { success: true, revision: `demo-${Date.now()}` };
    },
    async setMany() {
      return rejected("Bulk writes are not supported in the demo");
    },
  };
}

/** Demo-only in-memory writes acknowledge local state, never a Weaver server commit. */
export function createDemoTransport(): LocalTransport &
  Required<
    Pick<
      WeaverTransport,
      | "fetchSchemas"
      | "listRegisteredSchemaIdentities"
      | "listRegisteredSchemaIdentityPage"
      | "getRegisteredSchema"
    >
  > {
  const layers: Layers = {
    core: structuredClone(CORE_SEED),
    app: structuredClone(APP_SEED),
    user: {},
  };
  const snapshot = structuredClone(SEED_SNAPSHOT);
  const local = createLocalTransport({ snapshot });
  const pages = createSeededSchemaPages(seededSchemaIdentities());
  return {
    ...local,
    writeAuthority: "local",
    ...writeMethods(layers, snapshot, local),
    async fetchSchemas() {
      return registeredSchemaFixtures();
    },
    async listRegisteredSchemaIdentities() {
      return seededSchemaIdentities();
    },
    async listRegisteredSchemaIdentityPage(input) {
      return pages.page(input);
    },
    async getRegisteredSchema(anchorPath, environment) {
      return seededSchemaDetail(anchorPath, environment);
    },
    async resolveAll() {
      return structuredClone(snapshot);
    },
    async inspect(key) {
      const layerValues = {
        core: deepGet(layers.core, key),
        app: deepGet(layers.app, key),
        user: deepGet(layers.user, key),
      };
      const effectiveLayer = winner(layers, key);
      return {
        key,
        effectiveValue: effectiveLayer
          ? layerValues[effectiveLayer]
          : undefined,
        effectiveLayer,
        layerValues,
      };
    },
  };
}
