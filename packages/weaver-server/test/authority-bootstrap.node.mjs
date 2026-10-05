import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRegistryAdapter } from "@weaver-conf/config-registry/internal/server-adapter";
import { createFileSystemStorageProvider } from "@weaver-conf/storage-providers";
import { captureAuthorityRegistryLoader } from "../src/core/authority-registry-bootstrap.ts";
import { serializeRegistry } from "../src/core/schema-registry-persistence.ts";

function persistedRegistry() {
  const adapter = createRegistryAdapter({ defaultEnvironment: "dev" });
  let state;
  for (const environment of ["dev", "production"]) {
    const owner = { name: "host", contact: "host@example.org" };
    const requests = [
      {
        serviceId: "example", environment, owner,
        schema: { type: "object", properties: { "literal.dot": { type: "string" }, "雪": { type: "null" } } },
        fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
      },
      {
        serviceId: "example", environment, owner,
        providerId: "plugin", slotPath: "/plugins", schema: { type: "object" },
      },
    ];
    for (const request of requests) {
      const prepared = adapter.prepare(request);
      assert.equal(prepared.result.success, true, prepared.result.error?.message);
      state = prepared.candidate;
      prepared.publish();
    }
  }
  return { serialized: serializeRegistry(state), reader: adapter.reader };
}

function configuration(provider, operation = { kind: "load" }) {
  return {
    identity: { environment: "dev", scopePath: [] }, schemas: [],
    layers: [{ kind: "fixed", layer: "files", providerIds: ["registry"] }],
    providers: [{
      id: "registry", layer: "files", provider,
      environment: { kind: "environments", environments: ["dev"] },
      operation, ownership: { kind: "borrowed" },
    }],
  };
}
const selection = { providerId: "registry", layer: "files" };

for (const version of [1, 2]) {
  for (const kind of ["load", "load-layer"]) {
    test(`durable registry v${version} ${kind} preserves canonical identities and bytes`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "weaver-authority-registry-"));
      const filePath = join(directory, "config.json");
      const provider = createFileSystemStorageProvider({
        id: "registry", layer: "files", filePath, writable: true,
      });
      try {
        const { serialized, reader: expected } = persistedRegistry();
        const raw = version === 1 ? { environments: serialized.environments } : serialized;
        const dialect = "actual:日本";
        const operation = kind === "load" ? { kind } : { kind, layer: dialect };
        const written = kind === "load"
          ? await provider.write("_weaver.registry.schemas", raw)
          : await provider.writeLayer(dialect, "_weaver.registry.schemas", raw);
        assert.equal(written.success, true);
        const storagePath = kind === "load" ? filePath : `${filePath}.${encodeURIComponent(dialect)}.json`;
        const before = await readFile(storagePath);
        const loader = captureAuthorityRegistryLoader(configuration(provider, operation), selection, 50);
        const reader = await loader();
        assert.deepEqual(reader.listRegisteredSchemaIdentities(), expected.listRegisteredSchemaIdentities());
        assert.deepEqual(reader.getRegisteredSchema("/example", "dev"),
          expected.getRegisteredSchema("/example", "dev"));
        assert.deepEqual(reader.getRegisteredSchema("/example/plugins/plugin", "production"),
          expected.getRegisteredSchema("/example/plugins/plugin", "production"));
        assert.equal(reader.prepare, undefined);
        assert.equal(reader.register, undefined);
        assert.deepEqual(await readFile(storagePath), before);
      } finally {
        provider.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

class ReceiverProvider {
  id = "registry";
  layer = "files";
  writable = true;
  calls = [];
  data = { entries: { _weaver: { registry: { schemas: { version: 2, environments: {} } } } } };
  async load() { this.calls.push("load"); return this.data; }
  async loadLayer(layer) { this.calls.push(layer); return this.data; }
  async write() { assert.fail("bootstrap must not write"); }
  async remove() { assert.fail("bootstrap must not remove"); }
}

test("captures prototype method once, retains original receiver and dialect", async () => {
  const provider = new ReceiverProvider();
  const input = configuration(provider, { kind: "load-layer", layer: "actual:雪" });
  const load = captureAuthorityRegistryLoader(input, selection);
  assert.deepEqual(provider.calls, []);
  input.providers[0].operation.layer = "changed";
  provider.loadLayer = () => assert.fail("replacement must not run");
  const reader = await load();
  assert.deepEqual(provider.calls, ["actual:雪"]);
  assert.deepEqual(reader.listRegisteredSchemaIdentities().anchors, []);
});

test("binding validation fails before storage IO", () => {
  const mutations = [
    (input) => { input.providers.push(input.providers[0]); },
    (input) => { input.layers[0].kind = "scope"; },
    (input) => { input.providers[0].scopePath = [{ scopeId: "tenant", value: "one" }]; },
    (input) => { input.providers[0].environment.environments = ["other"]; },
    (input) => { input.providers[0].provider.id = "other"; },
    (input) => { input.providers[0].provider.layer = "other"; },
    (input) => { input.layers[0].layer = "other"; },
    (input) => { input.layers.push(input.layers[0]); },
    (input) => { Object.defineProperty(input.providers[0].provider, "load", {
      get() { assert.fail("accessor must not run"); },
    }); },
  ];
  for (const mutate of mutations) {
    const provider = new ReceiverProvider();
    const input = configuration(provider);
    mutate(input);
    assert.throws(() => captureAuthorityRegistryLoader(input, selection), { code: "VALIDATION_ERROR" });
    assert.deepEqual(provider.calls, []);
  }
  const provider = new ReceiverProvider();
  assert.throws(() => captureAuthorityRegistryLoader(configuration(provider), selection, 49), { code: "VALIDATION_ERROR" });
  assert.throws(() => captureAuthorityRegistryLoader(configuration(provider, {
    kind: "read", read: () => assert.fail("custom read must not run"),
  }), selection), { code: "UNSUPPORTED_OPERATION" });
  assert.deepEqual(provider.calls, []);
});

test("missing and incomplete metadata never become an empty registry", async () => {
  for (const entries of [{}, { _weaver: {} }, { _weaver: { registry: {} } },
    { _weaver: { registry: { schemas: undefined } } },
    { _weaver: { registry: { schemas: {} } } }]) {
    const provider = new ReceiverProvider();
    provider.data = { entries };
    await assert.rejects(captureAuthorityRegistryLoader(configuration(provider), selection)(),
      { code: "SERVER_DEGRADED" });
    assert.deepEqual(provider.calls, ["load"]);
  }
});

test("invalid layer descriptors and persisted metadata reject without leaking input", async () => {
  const accessor = {};
  Object.defineProperty(accessor, "_weaver", {
    enumerable: true, get() { assert.fail("metadata getter must not run"); },
  });
  const { serialized } = persistedRegistry();
  const corrupt = structuredClone(serialized);
  corrupt.environments.dev.schemas["/example"].metadata.environment = "SECRET";
  const badCodec = structuredClone(serialized);
  badCodec.environments.dev.schemas["/example"].schema = { encoding: "SECRET" };
  for (const entries of [accessor,
    { _weaver: { registry: { schemas: { version: 99, environments: {} } } } },
    { _weaver: { registry: { schemas: corrupt } } },
    { _weaver: { registry: { schemas: badCodec } } }]) {
    const provider = new ReceiverProvider();
    provider.data = { entries };
    await assert.rejects(captureAuthorityRegistryLoader(configuration(provider), selection)(), (error) => {
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.doesNotMatch(error.message, /SECRET/);
      assert.equal(error.details, undefined);
      return true;
    });
  }
});

test("storage failures are sanitized and not retried", async () => {
  const provider = new ReceiverProvider();
  provider.load = async () => { provider.calls.push("load"); throw new Error("SECRET"); };
  await assert.rejects(captureAuthorityRegistryLoader(configuration(provider), selection)(), (error) => {
    assert.equal(error.code, "SERVER_DEGRADED");
    assert.doesNotMatch(error.message, /SECRET/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(provider.calls, ["load"]);
});
