import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryAdapter } from "@weaver-conf/config-registry/internal/server-adapter";
import { defineWeaver, Layers } from "@weaver-conf/config-types";
import { createFileSystemStorageProvider } from "@weaver-conf/storage-providers";
import { serializeRegistry } from "@weaver-conf/config-registry/persistence";

export const testSecret = "authority-tests-only-not-a-production-secret";
export function jwt(claims = {}, secret = testSecret, alg = "HS256") {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg, typ: "JWT" })}.${encode({ sub: "alice", exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}
export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
export function canonicalSeed(environment) {
  const adapter = createRegistryAdapter({ defaultEnvironment: environment });
  let state;
  for (const serviceId of ["example", "other"]) {
    const request = { serviceId, environment, owner: { name: "host", contact: "host@example.org" },
      fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
      schema: { type: "object", properties: {
        name: { type: "string" }, "literal.dot": { type: "string" }, "雪": { type: "null" },
        "[literal]": { type: "string" }, count: { type: "number" },
        blocked: { type: "string", "x-weaver": { writeRestriction: ["unassigned"] } },
      } } };
    for (const item of [request, { serviceId, environment, owner: request.owner,
      providerId: "plugin", slotPath: "/plugins", schema: { type: "object" } }]) {
      const prepared = adapter.prepare(item);
      assert.equal(prepared.result.success, true, prepared.result.error?.message);
      state = prepared.candidate; prepared.publish();
    }
  }
  return { serialized: serializeRegistry(state) };
}

function instrument(provider) {
  const calls = { load: 0, write: 0, remove: 0, flush: 0, close: 0 };
  const control = { calls, beforeWrite: undefined, flush: undefined, outcome: undefined };
  for (const [method, counter] of [["loadLayer", "load"], ["writeLayer", "write"], ["removeLayer", "remove"]]) {
    const original = provider[method];
    provider[method] = async function (...args) {
      assert.equal(this, provider); calls[counter]++;
      if (counter === "write" && control.beforeWrite) await control.beforeWrite();
      const result = await Reflect.apply(original, this, args);
      if (counter === "write" && control.outcome) return control.outcome(result);
      return result;
    };
  }
  provider.flush = async function () { assert.equal(this, provider); calls.flush++; await control.flush?.(); };
  control.dispose = () => { calls.close++; provider.dispose(); };
  return control;
}

export async function filesystemHost({ environment = "dev", dialect = false, initialScope = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "weaver-authority-host-"));
  const registry = canonicalSeed(environment);
  const providers = [];
  const controls = {};
  const rows = [["base", "base", undefined], ["a", "tenant", "a"], ["b", "tenant", "b"], ["late", "late", undefined]];
  for (const [id, layer, tenant] of rows) {
    const provider = createFileSystemStorageProvider({ id, layer, filePath: join(directory, `${id}.json`), writable: true });
    const operation = dialect ? { kind: "load-layer", layer: `stored:${id}` } : { kind: "load" };
    const write = (key, value) => dialect ? provider.writeLayer(operation.layer, key, value) : provider.write(key, value);
    for (const namespace of ["example", "other"]) {
      await write(namespace, id === "base" ? { name: "base", count: 1, blocked: "base" } :
        tenant ? { name: `tenant-${tenant}`, count: 2 } : { count: 3 });
    }
    if (id === "base") await write("_weaver.registry.schemas", registry.serialized);
    controls[id] = instrument(provider);
    providers.push({ id, layer, provider, operation, environment: { kind: "environments", environments: [environment] },
      ...(tenant ? { scopePath: [{ scopeId: "tenant", value: tenant }] } : {}),
      ownership: { kind: "owned", dispose: controls[id].dispose } });
  }
  const configuration = { identity: { environment, scopePath: initialScope }, schemas: [], providers,
    layers: [{ kind: "fixed", layer: "base", providerIds: ["base"] },
      { kind: "scope", layer: "tenant", providerIds: ["a", "b"] },
      { kind: "fixed", layer: "late", providerIds: ["late"] }] };
  const authority = hostOptions(configuration);
  return { directory, registry, controls, authority,
    options: { port: 0, jwtSecret: testSecret, authority },
    cleanup: async () => { for (const row of providers) row.provider.dispose(); await rm(directory, { recursive: true, force: true }); },
  };
}

export function hostOptions(configuration) {
  const layers = configuration.layers.map((slot) => slot.layer);
  const environment = configuration.identity.environment;
  return { configuration, registry: { providerId: "base", layer: "base" },
    authConfig: { weaverConfig: defineWeaver(layers.map((layer) => Layers.Static(layer))),
      visibilityRoles: { admin: new Set(), platform: new Set() },
      layerWritePolicies: layers.map((layer) => ({ layer, allowedRoles: ["editor"] })), dynamicScopeRoles: new Set() },
    hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" },
    writers: configuration.providers.map((binding) => ({ providerId: binding.id,
      operation: binding.operation.kind === "load" ? { kind: "write" } : { kind: "write-layer", layer: binding.operation.layer },
      flush: "required", failureSemantics: "unknown" })),
    mapPrincipal(context) {
      const id = context.identity.userId;
      const namespace = id === "alice" ? "/example" : "/other";
      const tenant = id === "alice" ? "a" : "b";
      return { principalId: id, roles: ["editor"], grants: [[], [{ scopeId: "tenant", value: tenant }]].map((scopePath) => ({
        identity: { environment, scopePath }, namespace, operations: ["read", "inspect", "write"], layers, views: [], sensitive: false,
      })) };
    },
  };
}

export async function http(server, path, { method = "GET", token = jwt(), body, headers = {}, signal } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method, signal, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
}
export function effects(fixture) {
  return Object.values(fixture.controls).map(({ calls }) => [calls.write, calls.remove, calls.flush]);
}
