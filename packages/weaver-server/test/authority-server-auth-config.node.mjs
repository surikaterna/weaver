import assert from "node:assert/strict";
import { test } from "node:test";
import { withAuth } from "@weaver-conf/config-auth";
import { captureServerAuthConfig } from "../src/server-auth-config.ts";
import { startWeaverServerInternal } from "../src/server.ts";
import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createHmac } from "node:crypto";

function provider(id, layer, scoped = false) {
  return { id, layer, writable: true, load: async () => ({ entries: {} }), write: async () => ({ success: true }), remove: async () => ({ success: true }),
    ...(scoped ? { loadLayer: async () => ({ entries: {} }), writeLayer: async () => ({ success: true }), removeLayer: async () => ({ success: true }) } : {}) };
}

test("captured actual configured names deduplicate slot rank and detach provider order/names", () => {
  const providers = [provider("a", "custom"), provider("b", "tenant", true), provider("c", "custom"), provider("d", "last")];
  const config = captureServerAuthConfig(providers);
  assert.deepEqual(config.layerNames, ["custom", "tenant", "last"]);
  assert.deepEqual([...config.rankMap], [["custom", 0], ["tenant", 1], ["last", 2]]);
  providers[0].layer = "changed"; providers.reverse(); providers.push(provider("e", "admin"));
  assert.equal(config.getRank("custom"), 0); assert.equal(config.getRank("last"), 2);
  assert.equal(config.getRank("changed"), -1); assert.equal(config.getRank("admin"), -1);
  assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(config.layerNames));
  assert.equal(config.rankMap.set, undefined);
  config.rankMap.forEach((_rank, _name, map) => assert.equal(map, config.rankMap));
});

test("dynamic requests map only through the existing complete scoped IO capability and its own slot", () => {
  const readOnly = { ...provider("read", "read"), loadLayer: async () => ({ entries: {} }) };
  const config = captureServerAuthConfig([provider("exact", "tenant:one"), provider("dynamic", "tenant", true), readOnly, provider("plain", "plain")]);
  assert.equal(config.getRank("tenant:one"), 0);
  assert.equal(config.getRank("tenant:two"), 1);
  assert.equal(config.getRank("tenant:literal:雪"), 1);
  for (const name of ["tenant:", ":one", "missing:one", "read:one", "plain:one", "admin", "tenant-other:one"])
    assert.equal(config.getRank(name), -1, name);
  assert.equal(captureServerAuthConfig([provider("only", "tenant:one", true)]).getRank("tenant:two"), -1);
});

test("withAuth uses captured custom ranks and fails unknown targets/ceilings even for trusted emergency", () => {
  const auth = withAuth({ weaverConfig: captureServerAuthConfig([provider("a", "custom"), provider("b", "scope", true), provider("s", "incident")]),
    visibilityRoles: { admin: new Set(["operator"]), platform: new Set() }, layerWritePolicies: [], dynamicScopeRoles: new Set(["operator"]), sessionLayer: "incident" });
  const context = { userId: "verified", roles: ["operator"], trustedSession: { id: "verified", emergency: true, reason: "incident" } };
  const schema = (name) => ({ type: "string", "x-weaver": { maxOverrideLayer: name } });
  assert.equal(auth.canWrite(context, "scope:a", "x", schema("scope")), true);
  assert.equal(auth.canWrite(context, "scope:a", "x", schema("custom")), false);
  assert.equal(auth.canWrite(context, "unknown", "x", undefined), false);
  assert.equal(auth.canWrite(context, "incident", "x", schema("unknown")), false);
  assert.equal(auth.canWrite({ ...context, roles: [] }, "scope:a", "x", undefined), false);
});

test("default server authorization receives actual bootstrap providers when options.providers is absent", async () => {
  const secret = "bootstrap-rank", provider = createInMemoryStorageProvider({ id: "custom", layer: "custom-tier" });
  const registryProvider = createInMemoryStorageProvider({ id: "registry", layer: "platform" });
  const input = [ { alg: "HS256", typ: "JWT" }, { sub: "admin", roles: ["admin"], exp: Math.floor(Date.now() / 1000) + 60 } ].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
  const jwt = `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
  const server = await startWeaverServerInternal({ port: 0, jwtSecret: secret }, async () => ({ providers: [provider, registryProvider], dispose: async () => {} }));
  const send = async (url, body) => {
    const result = await fetch(`http://localhost:${server.port}${url}`, { method: "PUT", headers: { authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  };
  try {
    // The unregistered write reaches canonical declaration admission, not rank denial.
    const known = await send("/v1/config/unregistered?layer=custom-tier", { value: "x" });
    assert.equal(known.status, 400, JSON.stringify(known));
    assert.equal(known.body.error.code, "SCHEMA_NOT_REGISTERED");
    assert.equal((await send("/v1/config/unregistered?layer=tenant", { value: "x" })).status, 403);
    assert.equal((await send("/v1/config/unregistered?layer=admin", { value: "x" })).status, 403);
  } finally { await server.close(); }
});
