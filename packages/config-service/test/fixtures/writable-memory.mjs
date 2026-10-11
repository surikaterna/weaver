import { deepSet, deepRemove } from "@weaver-conf/config-engine";
import { createConfigurationService } from "../../dist/index.js";
import { authConfig, principal } from "./authority.mjs";
import { binding, options } from "./memory.mjs";

export class WritableMemory {
  writable = true;
  loads = 0; writes = 0; removes = 0; flushes = 0;
  constructor(id = "disk", layer = "base", entries = { alpha: { flag: "before", cfg: { a: 1 } } }) {
    Object.assign(this, { id, layer, entries: structuredClone(entries) });
  }
  async load() { this.loads++; return { entries: structuredClone(this.entries) }; }
  async loadLayer(layer) { this.readDialect = layer; return this.load(); }
  async write(key, value) { this.writes++; deepSet(this.entries, key, value); return { success: true, revision: "provider-revision" }; }
  async remove(key) { this.removes++; deepRemove(this.entries, key); return { success: true }; }
  async writeLayer(layer, key, value) { this.writeDialect = layer; return this.write(key, value); }
  async removeLayer(layer, key) { this.removeDialect = layer; return this.remove(key); }
  async flush() { this.flushes++; }
}
export function writeBinding(provider, extra = {}) {
  return binding(provider, { environment: { kind: "environments", environments: ["east"] }, ...extra });
}
export function writableOptions(providers) {
  return options(providers, { providers: providers.map((provider) => writeBinding(provider)) });
}
export function writer(provider, extra = {}) {
  return { providerId: provider.id, operation: { kind: "write" }, flush: "none", failureSemantics: "unknown", ...extra };
}
export async function writable({ provider = new WritableMemory(), input = writableOptions([provider]), host = {}, claims, readerClaims } = {}) {
  let controller;
  const supplied = { authConfig: authConfig(input), writers: [writer(provider)],
    hostAuthority: { authorizeReadSync: () => "allowed", authorizeWrite: async () => "allowed" },
    onAuthorityReady(value) { controller = value; }, ...host };
  const root = await createConfigurationService(input, supplied);
  const token = controller.mint(claims ?? principal(input));
  const reader = controller.forIdentity(readerClaims ? controller.mint(readerClaims) : token, { identity: input.identity, namespace: "/alpha" });
  return { root, reader, provider, input, host: supplied, controller, token, mutations: controller.forMutations(token) };
}

export function commands(input, ...items) {
  return items.map((item) => ({ identity: input.identity, namespace: "/alpha", layer: "base", ...item }));
}
