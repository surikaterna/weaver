import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigurationService } from "../dist/index.js";
import { WritableMemory, writable, writableOptions, writer } from "./fixtures/writable-memory.mjs";
import { authConfig } from "./fixtures/authority.mjs";
import { registration } from "./fixtures/memory.mjs";
import { withConsumer } from "./fixtures/packed-consumer.mjs";

test("all writer binding capabilities/dialects/selectors validate before provider loading", async () => {
  for (const invalid of ["duplicate", "unknown", "common", "multiple-env", "dialect", "missing-flush", "getter", "readonly", "custom"]) {
    const provider = new WritableMemory(), input = writableOptions([provider]); let getters = 0;
    const declaration = writer(provider);
    if (invalid === "common") input.providers[0].environment = { kind: "common" };
    if (invalid === "multiple-env") input.providers[0].environment.environments.push("west");
    if (invalid === "unknown") declaration.providerId = "other";
    if (invalid === "dialect") declaration.operation = { kind: "write-layer", layer: "other" };
    if (invalid === "custom") input.providers[0].operation = { kind: "read", read: () => provider.load() };
    if (invalid === "missing-flush") { declaration.flush = "required"; provider.flush = undefined; }
    if (invalid === "readonly") provider.writable = false;
    if (invalid === "getter") Object.defineProperty(provider, "write", { get() { getters++; return () => {}; } });
    const writers = invalid === "duplicate" ? [declaration, declaration] : [declaration];
    await assert.rejects(createConfigurationService(input, { authConfig: authConfig(input), writers }));
    assert.equal(provider.loads + provider.writes + provider.removes + provider.flushes, 0, invalid);
    assert.equal(getters, 0);
  }
});
test("captured class writer methods retain receiver and flush:none never reads a flush getter", async () => {
  const provider = new WritableMemory(); let getters = 0;
  Object.defineProperty(provider, "flush", { get() { getters++; throw Error("never"); } });
  const { root } = await writable({ provider });
  try {
    provider.write = () => { throw Error("replacement must not run"); };
    assert.equal((await root.set("/alpha/flag", "captured", { layer: "base" })).success, true);
    assert.equal(provider.entries.alpha.flag, "captured"); assert.equal(getters, 0);
    assert.equal(Object.isFrozen(provider), false);
  } finally { await root.dispose(); }
});

test("real public FS provider ordinary/layer writes roundtrip; malformed unknown readback preserves confirmation", async () => {
  await withConsumer(async (directory) => {
    const { createRequire } = await import("node:module");
    const require = createRequire(join(directory, "package.json"));
    const { createFileSystemStorageProvider } = require("@weaver-conf/storage-providers");
    for (const dialect of ["write", "write-layer"]) {
      const files = await mkdtemp(join(tmpdir(), "governed-files-"));
      try { await filesystemCase(createFileSystemStorageProvider, files, dialect); }
      finally { await rm(files, { recursive: true, force: true }); }
    }
  });
});
async function filesystemCase(createProvider, directory, dialect) {
  const filePath = join(directory, "config.json"), layer = "mapped:雪";
  const provider = createProvider({ id: "disk", layer: "base", filePath, writable: true });
  const selected = dialect === "write" ? filePath : `${filePath}.${encodeURIComponent(layer)}.json`;
  const input = writableOptions([provider]);
  input.schemas = [registration("east", "alpha", { type: "object", properties: { "literal.dot": { type: "string" }, "雪": { type: "null" } } })];
  if (dialect === "write-layer") input.providers[0].operation = { kind: "load-layer", layer };
  const declaration = writer(provider, { operation: dialect === "write" ? { kind: "write" } : { kind: "write-layer", layer } });
  let setup = await writable({ provider, input, host: { writers: [declaration] } });
  try {
    assert.equal((await setup.root.set("/alpha/literal.dot", "persisted", { layer: "base" })).success, true);
    assert.equal((await setup.root.set("/alpha/雪", null, { layer: "base" })).success, true);
    assert.deepEqual(JSON.parse(await readFile(selected, "utf8")), { alpha: { "literal.dot": "persisted", "雪": null } });
  } finally { await setup.root.dispose(); }
  setup = await writable({ provider, input, host: { writers: [declaration] } });
  try {
    assert.equal(setup.root.get("/alpha/literal.dot"), "persisted");
    assert.equal((await setup.root.remove("/alpha/雪", { layer: "base" })).success, true);
    assert.deepEqual(JSON.parse(await readFile(selected, "utf8")), { alpha: { "literal.dot": "persisted" } });
  } finally { await setup.root.dispose(); }
  const method = dialect === "write" ? "write" : "writeLayer", read = dialect === "write" ? "load" : "loadLayer";
  let loads = 0; const original = provider[read];
  provider[read] = async function (...args) { loads++; return original.apply(this, args); };
  provider[method] = async () => { await writeFile(selected, "PRIVATE-CORRUPT {"); throw Error("uncertain"); };
  setup = await writable({ provider, input, host: { writers: [declaration] } });
  try {
    const before = setup.root.inspect("/alpha/literal.dot"), revision = setup.root.revision, count = loads;
    const port = setup.controller.forIdentity(setup.token, input.identity, "/alpha");
    assert.equal((await setup.root.set("/alpha/literal.dot", "uncertain", { layer: "base" })).outcome, "unknown");
    assert.equal(loads, count + 1); assert.equal(setup.root.revision, revision);
    assert.deepEqual(setup.root.inspect("/alpha/literal.dot"), before); assert.equal(setup.root.mode, "degraded");
    assert.equal(port.get("/alpha/literal.dot"), "persisted"); assert.equal(port.revision, revision);
    assert.equal((await setup.root.remove("/alpha/literal.dot", { layer: "base" })).error.code, "WRITE_UNAVAILABLE");
    assert.equal((await port.remove("/alpha/literal.dot", { layer: "base" })).error.code, "WRITE_UNAVAILABLE"); assert.equal(loads, count + 1);
  } finally { await setup.root.dispose(); provider.dispose(); }
}
