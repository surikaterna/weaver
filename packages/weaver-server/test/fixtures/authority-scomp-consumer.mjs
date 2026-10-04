import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { clientFactory, createLoopbackTransport } from "./authority-scomp-loopback.mjs";

const require = createRequire(import.meta.url);
const load = (name, format) => format === "cjs" ? require(name) : import(name);
// This is the real host peer at its public ESM entry, not a Weaver CJS fallback.
const { createScompPeer, createContractToken } = await import("@scompr/core");

async function serviceFixture(serverPackage, label) {
  const provider = serverPackage.createFileSystemStorageProvider({
    id: "platform", layer: "platform", filePath: join(process.cwd(), `${label}.json`), writable: true,
  });
  assert.equal((await provider.write("pair.name", "initial")).success, true);
  let writes = 0;
  const write = provider.writeLayer;
  provider.writeLayer = function (...args) { writes++; return Reflect.apply(write, this, args); };
  const configService = await serverPackage.createWeaverConfigService({ providers: [provider], environment: "dev" });
  const schemaRegistry = serverPackage.createSchemaRegistry({ configService });
  const registered = await schemaRegistry.register({ serviceId: "pair", environment: "dev",
    owner: { name: "test", contact: "test@example.org" }, fragmentSlots: [],
    schema: { type: "object", properties: { name: { type: "string" } } },
  });
  assert.equal(registered.success, true);
  const scopeManager = serverPackage.createScopeManager({ configService, schemaRegistry });
  return { provider, configService, get writes() { return writes; },
    service: serverPackage.createWeaverScompService({ configService, schemaRegistry, scopeManager, defaultEnvironment: "dev" }),
  };
}

async function roundtrip(client, fixture) {
  assert.equal(await client.get("pair.name"), "initial");
  assert.equal((await client.set("pair.name", "persisted", { layer: "platform" })).success, true);
  await fixture.configService.flush();
  assert.equal((await fixture.provider.load()).entries.pair.name, "persisted");
  assert.equal(await client.get("pair.name"), "persisted");
  const writes = fixture.writes, before = await fixture.provider.load();
  const denied = await client.set("pair.name", 42, { layer: "platform" });
  assert.equal(denied.success, false); assert.equal(denied.error.code, "VALIDATION_ERROR");
  await fixture.configService.flush();
  assert.equal(fixture.writes, writes); assert.deepEqual(await fixture.provider.load(), before);
  assert.equal((await client.remove("pair.name", { layer: "platform" })).success, true);
  await fixture.configService.flush();
  assert.equal((await fixture.provider.load()).entries.pair?.name, undefined);
  assert.equal(await client.get("pair.name"), undefined);
}

async function pair(serverFormat, transportFormat) {
  const label = `${serverFormat}-${transportFormat}`;
  const serverPackage = await load("@weaver-conf/weaver-server", serverFormat);
  const transportPackage = await load("@weaver-conf/transport-scomp", transportFormat);
  const fixture = await serviceFixture(serverPackage, label);
  const tcp = await createLoopbackTransport();
  const peer = createScompPeer({ transports: [tcp], clientFactory, controlPlane: false });
  let client;
  try {
    peer.provides(fixture.service);
    assert.equal(fixture.service.name, transportPackage.WeaverConfig.name);
    const otherToken = createContractToken(transportPackage.WeaverConfig.name);
    assert.notEqual(otherToken, transportPackage.WeaverConfig);
    assert.equal(peer.consumes(otherToken), peer.consumes(transportPackage.WeaverConfig));
    client = transportPackage.createScompTransport({ peer });
    for (const method of ["get", "set", "remove"])
      assert.ok(tcp.routeNames.includes(`${transportPackage.WeaverConfig.name}.${method}`));
    await roundtrip(client, fixture);
    assert.deepEqual(tcp.seen, ["get", "set", "get", "set", "remove", "get"].map((method) => `${transportPackage.WeaverConfig.name}.${method}`));
    console.log(`installed pair ${label} localhost:${tcp.port}: real core peer + public legacy Weaver service/transport, test-only TCP RPC; routes=${JSON.stringify(tcp.seen)}`);
  } finally {
    await client?.close(); await peer.close(); await fixture.configService.flush(); fixture.provider.dispose();
  }
  assert.throws(() => peer.consumes(transportPackage.WeaverConfig), /closed/);
}

for (const serverFormat of ["esm", "cjs"])
  for (const transportFormat of ["esm", "cjs"]) await pair(serverFormat, transportFormat);
