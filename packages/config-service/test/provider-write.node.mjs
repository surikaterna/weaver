import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigurationService } from "../dist/index.js";
import { WritableMemory, writable, writableOptions, writer, commands } from "./fixtures/writable-memory.mjs";
import { readonlyHost } from "./fixtures/authority.mjs";
import { registration } from "./fixtures/memory.mjs";
import { withConsumer } from "./fixtures/packed-consumer.mjs";

test("all writer binding capabilities/dialects/selectors validate before provider loading", async () => {
  for (const invalid of ["duplicate", "unknown", "common", "multiple-env", "dialect", "missing-flush", "getter", "readonly", "custom"]) {
    const provider = new WritableMemory(), input = writableOptions([provider]); let getters = 0;
    const host = readonlyHost(input);
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
    await assert.rejects(createConfigurationService(input, { ...host, writers }));
    assert.equal(provider.loads + provider.writes + provider.removes + provider.flushes, 0, invalid);
    assert.equal(getters, 0);
  }
});
test("captured class writer methods retain receiver and flush:none never reads a flush getter", async () => {
  const provider = new WritableMemory(); let getters = 0;
  Object.defineProperty(provider, "flush", { get() { getters++; throw Error("never"); } });
  const { root, mutations, input } = await writable({ provider });
  try {
    provider.write = () => { throw Error("replacement must not run"); };
    assert.equal((await mutations.apply(commands(input, { operation: "set", path: "/alpha/flag", value: "captured" }))).success, true);
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
    assert.equal((await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/literal.dot", value: "persisted" }, { operation: "set", path: "/alpha/雪", value: null }))).success, true);
    assert.deepEqual(JSON.parse(await readFile(selected, "utf8")), { alpha: { "literal.dot": "persisted", "雪": null } });
  } finally { await setup.root.dispose(); }
  setup = await writable({ provider, input, host: { writers: [declaration] } });
  try {
    assert.equal(setup.reader.get(["literal.dot"]), "persisted");
    assert.equal((await setup.mutations.apply(commands(input, { operation: "remove", path: "/alpha/雪" }))).success, true);
    assert.deepEqual(JSON.parse(await readFile(selected, "utf8")), { alpha: { "literal.dot": "persisted" } });
  } finally { await setup.root.dispose(); }
  const method = dialect === "write" ? "write" : "writeLayer", read = dialect === "write" ? "load" : "loadLayer";
  let loads = 0; const original = provider[read];
  provider[read] = async function (...args) { loads++; return original.apply(this, args); };
  provider[method] = async () => { await writeFile(selected, "PRIVATE-CORRUPT {"); throw Error("uncertain"); };
  setup = await writable({ provider, input, host: { writers: [declaration] } });
  try {
    const before = setup.reader.inspect(["literal.dot"]), revision = setup.reader.revision, count = loads;
    const port = setup.controller.forIdentity(setup.token, { identity: input.identity, namespace: "/alpha" });
    assert.equal((await setup.mutations.apply(commands(input, { operation: "set", path: "/alpha/literal.dot", value: "uncertain" }))).outcome, "unknown");
    assert.equal(loads, count + 1); assert.equal(setup.reader.revision, revision);
    assert.deepEqual(setup.reader.inspect(["literal.dot"]), before); assert.equal(setup.root.mode, "degraded");
    assert.equal(port.get(["literal.dot"]), "persisted"); assert.equal(port.revision, revision);
    assert.equal((await setup.mutations.apply(commands(input, { operation: "remove", path: "/alpha/literal.dot" }))).error.code, "WRITE_UNAVAILABLE");
    assert.equal("remove" in port, false); assert.equal(loads, count + 1);
  } finally { await setup.root.dispose(); provider.dispose(); }
}
