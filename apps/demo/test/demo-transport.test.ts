import assert from "node:assert/strict";
import { test } from "node:test";
import { deepGet } from "@weaver-conf/config-engine";
import { configDeltaSchema } from "@weaver-conf/config-types";
import { createWeaverClient } from "@weaver-conf/weaver-client";
import { bridgeLocalWrites, createDemoTransport } from "../src/demo-transport";
import { buildScopePath, LOCATIONS } from "../src/locations";
import { ALL_KEYS, SEED_SNAPSHOT } from "../src/seed-data";
import { readFile } from "../src/stubs/node-fs";
import { existsSync } from "../src/stubs/node-fs-sync";
import { dirname } from "../src/stubs/node-path";

test("nested seeds preserve base and scoped values", async () => {
  assert.equal(ALL_KEYS.length, 10);
  assert.deepEqual(
    ALL_KEYS.map((key) => deepGet(SEED_SNAPSHOT.entries, key)),
    ["system", "en", true, 14, "Inter", false, true, "daily", 10000, 3],
  );
  assert.equal(Object.keys(SEED_SNAPSHOT.entries).length, 1);
  const client = await createWeaverClient({
    transport: createDemoTransport(),
    scopeLoading: "eager",
  });
  for (const key of ALL_KEYS) assert.notEqual(client.get(key), undefined);
  const ui = client.namespace<{ theme: string; language: string }>("app.ui");
  assert.equal(ui.get("theme"), "system");
  assert.equal(ui.get("language"), "en");
  for (const [location, key, value] of [
    ["GBDVR", "app.feature.notifications.frequency", "hourly"],
    ["FRCQF", "app.ui.language", "fr"],
    ["NLEUR", "app.feature.notifications.frequency", "realtime"],
  ]) {
    if (!location || !key) throw new Error("Invalid test case");
    const loc = LOCATIONS.find((candidate) => candidate.code === location);
    if (!loc) throw new Error(`Unknown location ${location}`);
    assert.equal(client.getForScope(key, buildScopePath(loc)), value);
    for (const scopedKey of ALL_KEYS)
      assert.notEqual(
        client.getForScope(scopedKey, buildScopePath(loc)),
        undefined,
      );
  }
  await client.close();
});

test("successful local writes publish exactly one valid delta and update reads", async () => {
  const transport = createDemoTransport();
  const snapshot = await transport.resolveAll();
  const client = await createWeaverClient({ transport });
  const received: unknown[] = [];
  client.onChange("app.ui.theme", (deltas) => received.push(...deltas));
  assert.equal(
    (await client.set("app.ui.theme", "dark", { layer: "user" })).success,
    true,
  );
  assert.equal(client.get("app.ui.theme"), "dark");
  assert.equal(deepGet(snapshot.entries, "app.ui.theme"), "dark");
  assert.equal(snapshot.entries["app.ui.theme"], undefined);
  const setDelta = configDeltaSchema.parse(received[0]);
  assert.deepEqual(setDelta, {
    action: "set",
    key: "app.ui.theme",
    value: "dark",
    layer: "user",
    environment: "default",
    timestamp: setDelta.timestamp,
  });
  assert.ok(!Number.isNaN(Date.parse(setDelta.timestamp)));
  assert.deepEqual(
    received.map((delta) => configDeltaSchema.parse(delta).action),
    ["set"],
  );
  assert.equal(
    (await client.remove("app.ui.theme", { layer: "user" })).success,
    true,
  );
  assert.equal(client.get("app.ui.theme"), undefined);
  assert.equal(deepGet(snapshot.entries, "app.ui.theme"), undefined);
  assert.deepEqual(
    received.map((delta) => configDeltaSchema.parse(delta).action),
    ["set", "remove"],
  );
  await client.close();
});

test("failed write emits nothing", async () => {
  const transport = createDemoTransport();
  const failing = bridgeLocalWrites({
    ...transport,
    set: async () => ({
      success: false,
      error: { code: "denied", message: "denied" },
    }),
    remove: async () => ({ success: false }),
  });
  const deltas: unknown[] = [];
  failing.subscribe((delta) => deltas.push(delta));
  assert.equal((await failing.set("app.ui.theme", "dark")).success, false);
  assert.equal((await failing.remove("app.ui.theme")).success, false);
  assert.deepEqual(deltas, []);
});

test("browser Node import stubs remain fail-closed", () => {
  assert.throws(() => readFile(), /not available in browser/);
  assert.throws(() => existsSync(), /not available in browser/);
  assert.throws(() => dirname(), /not available in browser/);
});
