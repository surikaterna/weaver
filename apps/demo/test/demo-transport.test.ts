import assert from "node:assert/strict";
import { test } from "node:test";
import { deepGet } from "@weaver-conf/config-engine";
import { configDeltaSchema } from "@weaver-conf/config-types";
import { createWeaverClient } from "@weaver-conf/weaver-client";
import { createDemoTransport } from "../src/demo-transport";
import { buildScopePath, LOCATIONS } from "../src/locations";
import { ALL_KEYS, APP_SEED, CORE_SEED, SEED_SNAPSHOT } from "../src/seed-data";
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
  const bootSnapshot = await transport.resolveAll();
  const client = await createWeaverClient({ transport });
  const received: unknown[] = [];
  client.onChange("app.ui.theme", (deltas) => received.push(...deltas));
  assert.equal(deepGet(CORE_SEED, "app.ui.theme"), "light");
  assert.equal(deepGet(APP_SEED, "app.ui.theme"), "system");
  assert.deepEqual(await transport.inspect("app.ui.theme"), {
    key: "app.ui.theme",
    effectiveValue: "system",
    effectiveLayer: "app",
    layerValues: { core: "light", app: "system", user: undefined },
  });
  assert.equal(
    (await client.set("app.ui.theme", "dark", { layer: "user" })).success,
    true,
  );
  assert.equal(client.get("app.ui.theme"), "dark");
  assert.equal(deepGet(bootSnapshot.entries, "app.ui.theme"), "system");
  assert.equal(
    deepGet((await transport.resolveAll()).entries, "app.ui.theme"),
    "dark",
  );
  assert.equal(
    (await transport.resolveAll()).entries["app.ui.theme"],
    undefined,
  );
  assert.deepEqual(await transport.inspect("app.ui.theme"), {
    key: "app.ui.theme",
    effectiveValue: "dark",
    effectiveLayer: "user",
    layerValues: { core: "light", app: "system", user: "dark" },
  });
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
  assert.equal(client.get("app.ui.theme"), "system");
  assert.equal(
    client.namespace<{ theme: string }>("app.ui").get("theme"),
    "system",
  );
  assert.equal(
    deepGet((await transport.resolveAll()).entries, "app.ui.theme"),
    "system",
  );
  assert.deepEqual(await transport.inspect("app.ui.theme"), {
    key: "app.ui.theme",
    effectiveValue: "system",
    effectiveLayer: "app",
    layerValues: { core: "light", app: "system", user: undefined },
  });
  assert.deepEqual(
    received.map((delta) => {
      const parsed = configDeltaSchema.parse(delta);
      return [parsed.action, parsed.value, parsed.layer];
    }),
    [
      ["set", "dark", "user"],
      ["set", "system", "app"],
    ],
  );
  assert.equal(deepGet(CORE_SEED, "app.ui.theme"), "light");
  assert.equal(deepGet(APP_SEED, "app.ui.theme"), "system");
  await client.close();
});

test("unsupported, invalid and no-op writes do not mutate or emit", async () => {
  const transport = createDemoTransport();
  const deltas: unknown[] = [];
  transport.subscribe((delta) => deltas.push(delta));
  for (const [key, value, options] of [
    ["bad.key", "dark", { layer: "user" }],
    ["app.ui.theme", "blue", { layer: "user" }],
    ["app.ui.font.size", 100, { layer: "user" }],
    ["app.ui.font.size", Number.NaN, { layer: "user" }],
    ["app.ui.theme", "dark", { layer: "tenant" }],
    ["app.ui.theme", "dark", { layer: "session" }],
    ["app.ui.theme", "dark", { environment: "prod" }],
    ["app.ui.theme", "dark", { ifRevision: "old" }],
    ["app.ui.theme", "system", { layer: "user" }],
  ] as const)
    assert.equal((await transport.set(key, value, options)).success, false);
  assert.equal(
    (await transport.remove("app.ui.theme", { layer: "user" })).success,
    false,
  );
  assert.equal(
    (await transport.remove("app.ui.theme", { layer: "country:GB" })).success,
    false,
  );
  assert.equal(
    (await transport.setMany({ "app.ui.theme": "dark" })).success,
    false,
  );
  assert.equal(
    deepGet((await transport.resolveAll()).entries, "app.ui.theme"),
    "system",
  );
  assert.deepEqual(await transport.inspect("app.ui.theme"), {
    key: "app.ui.theme",
    effectiveValue: "system",
    effectiveLayer: "app",
    layerValues: { core: "light", app: "system", user: undefined },
  });
  assert.deepEqual(deltas, []);
});

test("removal falls back to core when app has no value", async () => {
  const transport = createDemoTransport();
  const deltas: unknown[] = [];
  transport.subscribe((delta) => deltas.push(configDeltaSchema.parse(delta)));
  assert.equal(
    (await transport.set("app.ui.font.size", 18, { layer: "user" })).success,
    true,
  );
  assert.equal(
    (await transport.remove("app.ui.font.size", { layer: "user" })).success,
    true,
  );
  assert.deepEqual(
    deltas.map((delta) => [
      configDeltaSchema.parse(delta).value,
      configDeltaSchema.parse(delta).layer,
    ]),
    [
      [18, "user"],
      [14, "core"],
    ],
  );
  assert.equal(
    deepGet((await transport.resolveAll()).entries, "app.ui.font.size"),
    14,
  );
});

test("browser Node import stubs remain fail-closed", () => {
  assert.throws(() => readFile(), /not available in browser/);
  assert.throws(() => existsSync(), /not available in browser/);
  assert.throws(() => dirname(), /not available in browser/);
});
