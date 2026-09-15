import {
  configDeltaSchema,
  type ScopeInstance,
} from "@weaver-conf/config-types";
import { vi } from "vitest";
import { setupDeltaSubscription } from "./client-subscriptions";
import { createLocalTransport } from "./local-transport";
import { createClientSchemaRegistry } from "./schema-registry";
import { createScopeLoader, type ScopeLoadingMode } from "./scope-manager";
import type { ConfigDelta } from "./types";

const single: ScopeInstance[] = [{ scopeId: "tenant", value: "acme" }];
const multi: ScopeInstance[] = [...single, { scopeId: "region", value: "eu" }];
const modes: ScopeLoadingMode[] = ["eager", "hot", "lazy"];
const malformed = [
  "tenant:",
  ":acme",
  "tenant:acme/region:",
  "tenant:acme/",
  "tenant:acme//region:eu",
  "tenant:acme:extra",
  "tenant:acme,region:eu",
  "tenant:acme/region:eu:extra",
  "",
  "tenant/",
  "tenant: acme",
];

function delta(layer: string, action: "set" | "remove"): ConfigDelta {
  return {
    layer,
    action,
    key: "safe",
    value: "changed",
    environment: "dev",
    timestamp: new Date().toISOString(),
  };
}

function notifications() {
  const change = vi.fn();
  const restart = vi.fn();
  const onSync = vi.fn();
  const recordSync = vi.fn();
  const onRestartRequired = vi.fn();
  return {
    changeListeners: new Map([["*", new Set([change])]]),
    restartListeners: new Set([restart]),
    onSync,
    onRestartRequired,
    stalenessMonitor: {
      isStale: false,
      staleSince: null,
      recordSync,
      dispose() {},
      onStalenessChange: () => () => {},
    },
    spies: [change, restart, onSync, recordSync, onRestartRequired],
  };
}

async function setup(mode: ScopeLoadingMode) {
  const baseState = { safe: "base" };
  const snapshot = {
    entries: baseState,
    scopes: {
      "tenant:acme": { safe: "tenant" },
      "tenant:acme/region:eu": { safe: "region" },
    },
    revision: "test",
    timestamp: new Date().toISOString(),
  };
  const transport = createLocalTransport({ snapshot });
  const loader = createScopeLoader({
    mode,
    transport,
    initialSnapshot: snapshot,
  });
  await loader.preloadScope(single);
  await loader.preloadScope(multi);
  const registry = createClientSchemaRegistry();
  registry.load({
    safe: {
      type: "string",
      "x-weaver": { reloadBehavior: "restart-required" },
    },
  });
  const listeners = notifications();
  const applyScopedDelta = vi.fn((event: ConfigDelta, path: ScopeInstance[]) =>
    loader.applyDelta(event, path),
  );
  const unsubscribe = setupDeltaSubscription({
    baseState,
    transport,
    registry,
    ...listeners,
    applyScopedDelta,
  });
  return {
    baseState,
    loader,
    transport,
    unsubscribe,
    spies: [...listeners.spies, applyScopedDelta],
  };
}

describe.each(modes)("%s client scope boundary (weaver-9ii0)", (mode) => {
  it.each(malformed)("ignores set/remove for %j", async (layer) => {
    const fixture = await setup(mode);
    for (const action of ["set", "remove"] as const) {
      fixture.transport.pushDelta(
        configDeltaSchema.parse(delta(layer, action)),
      );
      expect(fixture.baseState).toEqual({ safe: "base" });
      expect(fixture.loader.getScopeState(single)).toEqual({ safe: "tenant" });
      expect(fixture.loader.getScopeState(multi)).toEqual({ safe: "region" });
      expect(fixture.loader.loadedScopes()).toEqual([
        "tenant:acme",
        "tenant:acme/region:eu",
      ]);
      for (const spy of fixture.spies) expect(spy).not.toHaveBeenCalled();
    }
    fixture.unsubscribe();
  });

  it.each([
    "platform",
    "effective",
    "tenant:acme",
    "tenant:acme/region:eu",
  ])("applies valid set/remove only to %s", async (layer) => {
    const fixture = await setup(mode);
    const target = layer.includes("region")
      ? multi
      : layer.includes(":")
        ? single
        : undefined;
    for (const action of ["set", "remove"] as const) {
      const event = configDeltaSchema.parse(delta(layer, action));
      fixture.transport.pushDelta(event);
      const expected = action === "set" ? { safe: "changed" } : {};
      expect(fixture.baseState).toEqual(target ? { safe: "base" } : expected);
      expect(fixture.loader.getScopeState(single)).toEqual(
        target === single ? expected : { safe: "tenant" },
      );
      expect(fixture.loader.getScopeState(multi)).toEqual(
        target === multi ? expected : { safe: "region" },
      );
    }
    fixture.unsubscribe();
  });
});
