import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import { createSchemaRegistry } from "../src/core/schema-registry.ts";
import { scopeContextId } from "../src/core/scope-inventory.ts";
import { createRestAdapter } from "../src/transport/rest-adapter.ts";
import { createSSEAdapter } from "../src/transport/sse-adapter.ts";
import { initialized, record } from "./validated-fixtures.mjs";

const tenantPath = [{ scopeId: "tenant", value: "acme" }];
const combinedPath = [...tenantPath, { scopeId: "region", value: "eu" }];
const defaults = { mode: "safe", limit: 7 };

async function fixture() {
  const contexts = [
    { scopePath: tenantPath, state: "active" },
    { scopePath: combinedPath, state: "active" },
    { scopePath: [{ scopeId: "tenant", value: "other" }], state: "active" },
    { scopePath: [{ scopeId: "tenant", value: "other" }, { scopeId: "region", value: "us" }], state: "active" },
    { scopePath: [{ scopeId: "tenant", value: "retired" }], state: "retired" },
  ];
  const f = await initialized({ data: { svc: {} }, records: [record("svc", {
      type: "object", additionalProperties: false, required: ["mode", "limit"],
      properties: { mode: { type: "string", default: "safe" }, limit: { type: "number", default: 7 } },
    })], scopes: [{ id: "tenant", label: "Tenant" }, { id: "region", label: "Region", parentScopeId: "tenant" }], contexts,
    scoped: { "tenant:acme": {}, "tenant:other": {}, "tenant:retired": {}, "region:eu": {}, "region:us": {} },
  });
  const service = f.service;
  const schemaRegistry = createSchemaRegistry({ configService: service });
  return {
    service, platform: f.platform, tenant: f.providers.find((provider) => provider.layer === "tenant"), region: f.providers.find((provider) => provider.layer === "region"), schemaRegistry,
    rest: createRestAdapter({ configService: service, schemaRegistry }),
    sse: createSSEAdapter({ configService: service }),
  };
}

function request(scope) {
  return { params: {}, headers: {}, query: { scope } };
}

function data(message) {
  const line = message?.split("\n").find((entry) => entry.startsWith("data: "));
  assert.ok(line);
  return JSON.parse(line.slice(6));
}

test("weaver-5bgr/69k: one coordinated defaulted state reaches every read and live projection", async () => {
  const f = await fixture();
  try {
    const revision = f.service.revision;
    assert.equal(await f.service.get("svc.mode"), defaults.mode);
    assert.deepEqual(await f.service.getNamespace("svc"), defaults);
    assert.deepEqual((await f.service.resolveAll({ scopePath: combinedPath })).scopes["tenant:acme/region:eu"].svc, defaults);
    const rest = await f.rest.handleRequest("GET", "/v1/config", request("tenant:acme,region:eu"));
    assert.equal(rest.status, 200);
    assert.deepEqual(rest.body.data.scopes["tenant:acme/region:eu"].svc, defaults);
    const validation = await f.rest.handleRequest("GET", "/v1/registered/effective/svc", request("tenant:acme,region:eu"));
    assert.equal(validation.status, 200);
    assert.equal(validation.body.data.valid, true);
    const client = await f.sse.createClient({ scope: "tenant:acme,region:eu" });
    assert.deepEqual(data(client.messages[0]).entries.svc, defaults);
    assert.equal(f.service.revision, revision);
    assert.deepEqual((await f.platform.load()).entries.svc, {});
    const results = await Promise.all([8, 9].map((value) => f.service.patchRegisteredPath(
      "platform", "/svc/limit", value, { schemaRegistry: f.schemaRegistry, expectedRevision: revision },
    )));
    assert.equal(results.filter((result) => result.success).length, 1);
    assert.equal(results.find((result) => !result.success)?.error.code, "REVISION_CONFLICT");
    const effective = await f.service.getNamespace("svc", { scopePath: combinedPath });
    assert.equal(effective.mode, defaults.mode);
    assert.ok([8, 9].includes(effective.limit));
    const projected = data(client.messages.at(-1));
    assert.equal(projected.layer, "tenant:acme/region:eu");
    assert.deepEqual(projected.value, effective);
    assert.deepEqual((await f.platform.load()).entries.svc, { limit: effective.limit });
  } finally {
    f.sse.closeAll();
    await f.service.close();
  }
});

test("weaver-becr/54ud: full inventory admission rejects retired data and unlisted combinations before subscription or warming", async () => {
  const f = await fixture();
  const resolve = mock.method(f.service, "resolveAll");
  const subscribe = mock.method(f.service, "onDelta");
  const loads = [mock.method(f.tenant, "loadLayer"), mock.method(f.region, "loadLayer")];
  try {
    for (const scope of ["tenant:retired", "tenant:acme/region:us", "missing:value"]) {
      for (const route of ["/v1/config", "/v1/config/svc/mode", "/v1/registered/effective/svc"]) {
        const response = await f.rest.handleRequest("GET", route, request(scope));
        assert.equal(response.status, 404);
        assert.equal(response.body.error.code, "SCOPE_NOT_FOUND");
      }
      await assert.rejects(f.sse.createClient({ scope }), { code: "SCOPE_NOT_FOUND" });
    }
    assert.equal(resolve.mock.callCount(), 0);
    assert.equal(subscribe.mock.callCount(), 0);
    assert.ok(loads.every((load) => load.mock.callCount() === 0));
    assert.equal(f.sse.clientCount, 0);
  } finally {
    mock.restoreAll();
    f.sse.closeAll();
    await f.service.close();
  }
});

test("weaver-s64i/54ud: inventory admission retains pending closeAll cancellation", async () => {
  const f = await fixture();
  const resolve = mock.method(f.service, "resolveAll");
  const subscribe = mock.method(f.service, "onDelta");
  try {
    const pending = f.sse.createClient({ scope: "tenant:acme/region:eu" });
    const canceled = assert.rejects(pending, { name: "AbortError" });
    f.sse.closeAll();
    await canceled;
    assert.equal(f.sse.clientCount, 0);
    assert.equal(resolve.mock.callCount(), 0);
    assert.equal(subscribe.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
    f.sse.closeAll();
    await f.service.close();
  }
});
