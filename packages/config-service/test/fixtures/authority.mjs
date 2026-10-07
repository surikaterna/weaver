import { defineWeaver, Layers } from "@weaver-conf/config-types";
import { createConfigurationService } from "../../dist/index.js";
import { MemoryProvider, options } from "./memory.mjs";

export function authConfig(input) {
  return {
    weaverConfig: defineWeaver(input.layers.map((slot) => Layers.Static(slot.layer))),
    visibilityRoles: { admin: new Set(["reader"]), platform: new Set(["reader"]) },
    layerWritePolicies: input.layers.map((slot) => ({ layer: slot.layer, allowedRoles: ["reader"] })),
    dynamicScopeRoles: new Set(),
  };
}
export function principal(input, changes = {}) {
  return { principalId: "host-verified", roles: ["reader"], grants: [{
    identity: structuredClone(input.identity), namespace: "/alpha", operations: ["read", "inspect", "write"],
    layers: input.layers.map((slot) => slot.layer), views: [], sensitive: false,
  }], ...changes };
}
export function readonlyHost(input) {
  return {
    authConfig: authConfig(input),
    hostAuthority: {
      authorizeReadSync() { return "allowed"; },
      async authorizeWrite() { return "denied"; },
    },
    onAuthorityReady() {},
  };
}
export async function hostedReader(input, namespace = "/alpha", factory = createConfigurationService) {
  const setup = await hosted(input, readonlyHost(input), factory);
  const identities = [input.identity, ...input.providers.flatMap((binding) =>
    binding.scopePath ? [{ environment: input.identity.environment, scopePath: binding.scopePath }] : [])];
  const claims = principal(input);
  claims.grants = identities.map((identity) => ({ ...claims.grants[0],
    identity: structuredClone(identity), namespace, operations: ["read", "inspect"],
  }));
  const token = setup.controller.mint(claims);
  const reader = setup.controller.forIdentity(token, { identity: input.identity, namespace });
  return { ...setup, reader };
}
export async function hosted(input = options([new MemoryProvider("p", "base", { alpha: { flag: "public", cfg: { a: 1 } }, beta: { flag: "other" } })]), overrides = {}, factory = createConfigurationService) {
  let controller;
  const calls = { reads: 0, writes: 0, ready: 0 };
  const host = {
    authConfig: authConfig(input),
    hostAuthority: {
      authorizeReadSync() { calls.reads++; return "allowed"; },
      async authorizeWrite() { calls.writes++; return "allowed"; },
    },
    onAuthorityReady(value) { calls.ready++; controller = value; },
    ...overrides,
  };
  const onReady = host.onAuthorityReady;
  host.onAuthorityReady = (value) => { controller = value; return onReady(value); };
  const root = await factory(input, host);
  return { root, controller, input, host, calls };
}
