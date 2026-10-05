import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { rootExports, internalExports } from "./operation-support-fixture.mjs";

const expected = {
  root: rootExports,
  internal: internalExports,
};
const smoke = `
  if (typeof process !== 'undefined' || typeof Buffer !== 'undefined' || typeof require !== 'undefined') throw Error('Node globals');
  const options = { defaultEnvironment: 'dev' };
  const internal = typeof api.createRegistryAdapter === 'function';
  const adapter = internal ? api.createRegistryAdapter(options) : null;
  const registry = internal ? adapter.reader : api.createCanonicalSchemaRegistry(options);
  const register = request => {
    if (!internal) return registry.register(request);
    const prepared = adapter.prepare(request);
    if (prepared.result.success) prepared.publish();
    return prepared.result;
  };
  const owner = { name: 'host', contact: 'host@example.org' };
  if (!register({ serviceId: 'svc', environment: 'dev', owner, schema: { type: 'object' }, fragmentSlots: [{ slotPath: '/plugins', accepts: 'object' }] }).success) throw Error('service');
  if (!register({ serviceId: 'svc', environment: 'dev', owner, providerId: 'p', slotPath: '/plugins', schema: { type: 'object', properties: { enabled: { type: 'boolean' } } } }).success) throw Error('fragment');
  if (registry.resolveAnchor('/svc/plugins/p/enabled').kind !== 'fragment') throw Error('read');
  if (registry.getSchema('svc', 'dev').type !== 'object') throw Error('service read');
  const first = registry.listRegisteredSchemaIdentityPage({ limit: 1 });
  const second = registry.listRegisteredSchemaIdentityPage({ cursor: first.nextCursor });
  if (first.nextCursor.length !== 55 || second.slots[0].path !== '/svc/plugins') throw Error('page');
  JSON.stringify({ keys: Object.keys(api).sort(), identities: registry.listRegisteredSchemaIdentities() });
`;

for (const [boundary, entry] of [["root", "index"], ["internal", "internal/server-adapter"]]) {
  for (const extension of ["js", "cjs"]) {
    test(`complete unshaken ${boundary} ${extension} browser graph registers/reads/pages with real Web Crypto`, async () => {
      const result = await build({
        entryPoints: [fileURLToPath(new URL(`../dist/${entry}.${extension}`, import.meta.url))],
        bundle: true, write: false, treeShaking: false, platform: "browser", format: "iife", globalName: "api", metafile: true,
      });
      const inputs = Object.keys(result.metafile.inputs);
      assert.equal(Object.values(result.metafile.outputs).flatMap(output => output.imports).length, 0);
      assert.equal(Object.values(result.metafile.inputs).flatMap(input => input.imports).filter(item => item.external).length, 0);
      assert.equal(inputs.some(input => /weaver-server|storage-provider|config-runtime|fs-persistence|node:/.test(input)), false);
      console.log(`${boundary} ${extension} full graph: ${JSON.stringify(inputs)}`);
      const context = createContext({ crypto: webcrypto, structuredClone });
      runInContext(result.outputFiles[0].text, context);
      const observed = JSON.parse(runInContext(smoke, context));
      assert.deepEqual(observed.keys, expected[boundary].toSorted());
      assert.equal(observed.identities.anchors.length, 2);
      assert.equal(observed.identities.slots.length, 1);
      console.log(`${boundary} ${extension}: real crypto, no Node globals, ${inputs.length} inputs, zero externals`);
      const unavailable = createContext({ structuredClone });
      runInContext(result.outputFiles[0].text, unavailable);
      assert.throws(() => runInContext(boundary === "root" ? "api.createCanonicalSchemaRegistry({ defaultEnvironment: 'dev' })" : "api.createRegistryAdapter({ defaultEnvironment: 'dev' })", unavailable), { code: "INTERNAL_ERROR" });
    });
  }
}

test("new public package has correctly nested root/internal ESM and CJS declaration exports", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.private, false);
  assert.equal(manifest.publishConfig.access, "public");
  assert.match(manifest.version, /^0\./);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@weaver-conf/config-engine", "@weaver-conf/config-types", "zod"]);
  for (const [key, stem] of [[".", "index"], ["./internal/server-adapter", "internal/server-adapter"]]) {
    for (const [mode, types, runtime] of [["import", "d.ts", "js"], ["require", "d.cts", "cjs"]]) {
      assert.deepEqual(Object.keys(manifest.exports[key][mode]), ["types", "default"]);
      assert.equal(manifest.exports[key][mode].types, `./dist/${stem}.${types}`);
      assert.equal(manifest.exports[key][mode].default, `./dist/${stem}.${runtime}`);
      const declarations = await readFile(new URL(`../dist/${stem}.${types}`, import.meta.url), "utf8");
      assert.doesNotMatch(declarations, /NodeJS|reference types="node"|node:/);
    }
  }
  console.log(`registry source manifest: version=${manifest.version}, private=${manifest.private}, access=${manifest.publishConfig.access}`);
});
