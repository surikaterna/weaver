import assert from "node:assert/strict";
import { test } from "node:test";
import { registeredConfigurationSchemaSchema } from "@weaver-conf/config-types";
import { createRestAdapter } from "../../src/transport/rest-adapter.ts";
import { createWeaverScompService } from "../../src/transport/scomp-service.ts";
import { createSSEAdapter } from "../../src/transport/sse-adapter.ts";
import { fixture, owner, registration, validateCanonicalSchema } from "./fixtures.mjs";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";

for (const profile of ["memory", "fs-restart"]) {
  test(`R4 marker defaults, including malformed discriminants, reject before effects (${profile})`, async (context) => {
    const { registry, writes, configService, activate } = await fixture(undefined, profile);
    await registry.register(registration({ type: "object" }, [{ slotPath: "/plugins", accepts: "object" }]));
    await activate();
    const before = writes.length;
    const registered = structuredClone(registry.listAll());
    const events = [];
    const revision = configService.revision;
    context.after(configService.onDelta((delta) => events.push(delta)));
    const markers = [{ _weaver: "secret-ref", provider: "vault", uri: "hidden" }, { _weaver: "mount", source: "hidden" }, { _weaver: "mount" }, { _weaver: "secret-ref" }];
    for (const marker of markers) {
      for (const value of [marker, [marker], { optional: marker }, { list: [{ nested: marker }] }]) {
        const schema = { type: "object", properties: { unused: { type: Array.isArray(value) ? "array" : "object", additionalProperties: true, default: value } } };
        assert.equal(registeredConfigurationSchemaSchema.safeParse(schema).success, false);
        for (const request of [registration(schema), { serviceId: "svc", environment: "dev", owner, providerId: "bad", slotPath: "/plugins", schema }]) {
          const result = await registry.register(request);
          assert.equal(result.success, false);
          assert.equal(result.error.code, "VALIDATION_ERROR");
          assert.match(result.error.message, /markers/);
        }
        assert.throws(() => validateCanonicalSchema(schema), { code: "VALIDATION_ERROR" });
      }
    }
    assert.equal(writes.length, before);
    assert.deepEqual(registry.listAll(), registered);
    assert.deepEqual(events, []);
    assert.equal(configService.revision, revision);
  });
}

test("R4 unrelated _weaver data defaults remain ordinary values across transport and scoped delivery", async (context) => {
  const tenant = createInMemoryStorageProvider({ id: "tenant", layer: "tenant" });
  await tenant.loadLayer("tenant:one");
  const { registry, configService, writes, activate } = await fixture(undefined, "memory", [tenant], [[{ scopeId: "tenant", value: "one" }]]);
  const ordinary = { _weaver: { label: "ordinary" }, list: [{ _weaver: "application-value" }] };
  await registry.register(registration({ type: "object", properties: { child: { type: "object", additionalProperties: true, default: ordinary } } }));
  await activate();
  const expected = { svc: { child: ordinary } };
  const snapshot = await configService.resolveAll({ scopePath: [{ scopeId: "tenant", value: "one" }] });
  assert.deepEqual(snapshot.entries, expected);
  assert.deepEqual(snapshot.scopes["tenant:one"], expected);
  const rest = createRestAdapter({ configService });
  assert.deepEqual((await rest.handleRequest("GET", "/v1/config", { params: {}, query: {}, headers: {} })).body.data.entries, expected);
  const scomp = createWeaverScompService({ configService, schemaRegistry: registry, scopeManager: {} });
  assert.deepEqual((await scomp.router["weaver-config-v1.resolveAll"].handler({})).entries, expected);
  const sse = createSSEAdapter({ configService });
  const client = await sse.createClient();
  context.after(() => client.close());
  const message = (text) => JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6));
  assert.deepEqual(message(client.messages[0]).entries, expected);
  assert.deepEqual(writes, []);
  await configService.set("platform", "svc", {});
  assert.deepEqual(message(client.messages.at(-1)).value, expected.svc);
});
