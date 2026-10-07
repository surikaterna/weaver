import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { withConsumer } from "./fixtures/packed-consumer.mjs";
import { hostedReader, readonlyHost } from "./fixtures/authority.mjs";

function input(bindings, extra = {}) {
  return {
    identity: { environment: "east", scopePath: [] },
    schemas: [{ serviceId: "alpha", environment: "east", owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [],
      schema: { type: "object", properties: { flag: { type: "string" } } } }],
    layers: bindings.map((binding) => ({ kind: "fixed", layer: binding.layer, providerIds: [binding.id] })),
    providers: bindings,
    ...extra,
  };
}
function binding(provider, extra = {}) {
  return { id: provider.id, layer: provider.layer, provider,
    environment: { kind: "environments", environments: ["east"] },
    operation: { kind: "load" }, ownership: { kind: "borrowed" }, ...extra };
}
function sanitized(code, filePath, providerId) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes(filePath));
    assert.ok(!JSON.stringify(error).includes("PRIVATE-SENTINEL"));
    if (providerId) assert.deepEqual(error.details.degradedProviders, [providerId]);
    return true;
  };
}
async function packedModules(directory, format) {
  const require = createRequire(join(directory, "package.json"));
  const load = async (name) => format === "cjs" ? require(name)
    : import(pathToFileURL(require.resolve(name).replace(/\.cjs$/, ".js")));
  return { ...await load("@weaver-conf/storage-providers"), ...await load("@weaver-conf/config-service") };
}
async function directReadProof(api, directory, format) {
  const filePath = join(directory, `${format}-direct.json`);
  const overlay = join(directory, `${format}-overlay.json`);
  const provider = api.createFileSystemStorageProvider({ id: "direct", layer: "base", filePath, environmentOverlayPath: overlay });
  try {
    for (const layer of [undefined, "base", "mapped:雪/leaf"]) {
      const path = layer === undefined || layer === "base" ? filePath : `${filePath}.${encodeURIComponent(layer)}.json`;
      const load = () => layer === undefined ? provider.load() : provider.loadLayer(layer);
      await rm(path, { force: true }); await rm(overlay, { force: true });
      assert.deepEqual((await load()).entries, {});
      await writeFile(path, "{}"); assert.deepEqual((await load()).entries, {});
      for (const contents of ["PRIVATE-SENTINEL {", "", " ", "null", "[]", "1"]) {
        await writeFile(path, contents);
        await assert.rejects(load(), sanitized("VALIDATION_ERROR", path));
      }
      await rm(path); await mkdir(path);
      await assert.rejects(load(), sanitized("SERVER_DEGRADED", path));
      await rm(path, { recursive: true }); await writeFile(path, '{"alpha":{"flag":"base"}}');
      assert.deepEqual((await load()).entries, { alpha: { flag: "base" } });
      await writeFile(overlay, "PRIVATE-SENTINEL {");
      await assert.rejects(load(), sanitized("VALIDATION_ERROR", overlay));
      await rm(overlay); await mkdir(overlay);
      await assert.rejects(load(), sanitized("SERVER_DEGRADED", overlay));
      await rm(overlay, { recursive: true }); await writeFile(overlay, '{"alpha":{"flag":"overlay"}}');
      assert.deepEqual((await load()).entries, { alpha: { flag: "overlay" } });
    }
  } finally { provider.dispose(); }
}
async function hydrationProof(api, directory, format) {
  const filePath = join(directory, `${format}-broken.json`);
  const goodPath = join(directory, `${format}-good.json`);
  await writeFile(filePath, "PRIVATE-SENTINEL {");
  await writeFile(goodPath, '{"alpha":{"flag":"confirmed"}}');
  const bad = api.createFileSystemStorageProvider({ id: "broken", layer: "broken", filePath });
  const good = api.createFileSystemStorageProvider({ id: "good", layer: "good", filePath: goodPath });
  const options = input([binding(good), binding(bad)]);
  try {
    for (const ioFailure of [false, true]) {
      if (ioFailure) { await rm(filePath); await mkdir(filePath); }
      await assert.rejects(api.createConfigurationService(options, readonlyHost(options)), sanitized("SERVER_DEGRADED", filePath, "broken"));
      const { root, reader } = await hostedReader({ ...options, failureMode: "allow-degraded" }, "/alpha", api.createConfigurationService);
      try {
        assert.equal(root.mode, "degraded");
        assert.deepEqual(root.degradedProviders, ["broken"]);
        assert.equal(reader.get(["flag"]), "confirmed");
        assert.ok(reader.inspect(["flag"]).contributions.every((item) => item.providerId !== "broken"));
        assert.equal(reader.get(["flag"], { layer: "broken" }), undefined);
      } finally { await root.dispose(); }
    }
    await rm(filePath, { recursive: true });
    for (const contents of [undefined, "{}"]) {
      if (contents) await writeFile(filePath, contents);
      const root = await api.createConfigurationService(options, readonlyHost(options));
      try { assert.equal(root.mode, "live"); assert.deepEqual(root.degradedProviders, []); }
      finally { await root.dispose(); }
    }
  } finally { good.dispose(); bad.dispose(); }
}
async function preloadProof(api, directory, format) {
  const basePath = join(directory, `${format}-scope-base.json`);
  const firstPath = join(directory, `${format}-scope-first.json`);
  const secondPath = join(directory, `${format}-scope-second.json`);
  await writeFile(basePath, '{"alpha":{"flag":"base"}}');
  await writeFile(firstPath, '{"alpha":{"flag":"first"}}');
  await writeFile(secondPath, "PRIVATE-SENTINEL {");
  const providers = [["base", "base", basePath], ["first", "scope", firstPath], ["second", "scope", secondPath]]
    .map(([id, layer, filePath]) => api.createFileSystemStorageProvider({ id, layer, filePath }));
  const first = [{ scopeId: "region", value: "first" }], second = [{ scopeId: "region", value: "second" }];
  const bindings = providers.map((provider, index) => binding(provider, index ? { scopePath: index === 1 ? first : second } : {}));
  const options = input(bindings, { layers: [{ kind: "fixed", layer: "base", providerIds: ["base"] }, { kind: "scope", layer: "scope", providerIds: ["first", "second"] }] });
  const { root, reader } = await hostedReader(options, "/alpha", api.createConfigurationService);
  try {
    const firstReader = reader.withScope(first), secondReader = reader.withScope(second);
    await firstReader.prepare();
    const revision = reader.revision, identity = reader.selection.identity, inspection = reader.inspect(["flag"]);
    await assert.rejects(secondReader.prepare(), sanitized("SERVER_DEGRADED", secondPath, "second"));
    assert.equal(reader.revision, revision); assert.deepEqual(reader.selection.identity, identity);
    assert.deepEqual(reader.inspect(["flag"]), inspection);
    assert.equal(reader.get(["flag"]), "base");
    assert.equal(firstReader.get(["flag"]), "first");
    assert.throws(() => secondReader.get(["flag"]), { code: "SCOPE_NOT_LOADED" });
    await writeFile(secondPath, '{"alpha":{"flag":"repaired"}}');
    await secondReader.prepare();
    assert.equal(secondReader.get(["flag"]), "repaired");
    assert.equal(reader.revision, revision);
  } finally { await root.dispose(); for (const provider of providers) provider.dispose(); }
}

test("packed ESM/CJS real filesystem failures propagate honestly through current service hydration", async (context) => {
  await withConsumer(async (directory) => {
    for (const format of ["esm", "cjs"]) {
      const api = await packedModules(directory, format);
      await context.test(`${format}: public filesystem read, empty and overlay semantics`, () => directReadProof(api, directory, format));
      await context.test(`${format}: default initialization rejects; explicit degraded policy omits failed provider`, () => hydrationProof(api, directory, format));
      await context.test(`${format}: failed cold preload preserves ready identities and revision`, () => preloadProof(api, directory, format));
    }
  });
});
