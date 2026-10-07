import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const directory = process.cwd();
const seed = JSON.parse(await readFile(join(directory, "seed.json"), "utf8"));
const secret = "packed-tests-only-not-a-production-secret";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const signing = `${encode({ alg: "HS256" })}.${encode({ sub: "packed", exp: Math.floor(Date.now() / 1000) + 300 })}`;
const token = `${signing}.${createHmac("sha256", secret).update(signing).digest("base64url")}`;
for (const format of [process.argv[2]]) {
  const load = (name) => format === "cjs" ? require(name) : import(name);
  const serverPackage = await load("@weaver-conf/weaver-server");
  const storage = await load("@weaver-conf/storage-providers");
  const types = await load("@weaver-conf/config-types");
  const provider = storage.createFileSystemStorageProvider({ id: "base", layer: "files", filePath: join(directory, `${format}.json`), writable: true });
  assert.equal((await provider.write("_weaver.registry.schemas", seed)).success, true);
  assert.equal((await provider.write("example.name", "initial")).success, true);
  const identity = { environment: "dev", scopePath: [] }; let closed = 0, mapped = 0;
  const authority = { configuration: { identity, schemas: [],
    layers: [{ kind: "fixed", layer: "files", providerIds: ["base"] }],
    providers: [{ id: "base", layer: "files", provider, operation: { kind: "load" },
      environment: { kind: "environments", environments: ["dev"] }, ownership: { kind: "owned", dispose: () => { closed++; provider.dispose(); } } }] },
    registry: { providerId: "base", layer: "files" },
    authConfig: { weaverConfig: types.defineWeaver([types.Layers.Static("files")]), visibilityRoles: { admin: new Set(), platform: new Set() },
      layerWritePolicies: [{ layer: "files", allowedRoles: ["editor"] }], dynamicScopeRoles: new Set() },
    hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" },
    writers: [{ providerId: "base", operation: { kind: "write" }, flush: "none", failureSemantics: "unknown" }],
    mapPrincipal(context) {
      mapped++; assert.equal(context.identity.userId, "packed");
      return { principalId: "packed", roles: ["editor"], grants: [{ identity, namespace: "/example",
        operations: ["read", "inspect", "write"], layers: ["files"], views: [], sensitive: false }] };
    } };
  assert.equal(serverPackage.serverAuthorityOptionsSchema.safeParse(authority).success, true);
  assert.equal(mapped, 0);
  const server = await serverPackage.startWeaverServer({ authority, port: 0, jwtSecret: secret });
  const request = async (suffix, method = "GET", value) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/config/example/name${suffix}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify({ value }) }),
    });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(response.headers.get("etag"), `"${body.meta.revision}"`); return body;
  };
  try {
    assert.equal((await request("")).data.value, "initial");
    const changed = await request("?layer=files", "PUT", "persisted");
    assert.equal(changed.data.revisions[0].revision, changed.meta.revision);
    assert.equal((await request("?inspect")).data.effective.value, "persisted");
    assert.equal((await provider.load()).entries.example.name, "persisted");
    assert.equal((await request("?layer=files", "DELETE")).data.success, true);
    assert.equal(Object.hasOwn((await request("")).data, "value"), false);
    const entry = format === "cjs" ? require.resolve("@weaver-conf/weaver-server") : import.meta.resolve("@weaver-conf/weaver-server");
    console.log(`authority packed ${format} localhost:${server.port}: real JWT GET/inspect/PUT/DELETE + FS persistence; ${entry}`);
  } finally { const closing = server.close(); assert.equal(server.close(), closing); await closing; }
  assert.equal(closed, 1);
}
