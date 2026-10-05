export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export class MemoryProvider {
  writable = true;
  loads = 0; writes = 0; removes = 0; flushes = 0;
  constructor(id, layer, entries, gate) { Object.assign(this, { id, layer, entries, gate }); }
  async load() { this.loads++; if (this.gate) await this.gate.promise; return { entries: this.entries }; }
  async loadLayer(layer) { this.dialect = layer; return this.load(); }
  async write() { this.writes++; return { success: true }; }
  async remove() { this.removes++; return { success: true }; }
  async flush() { this.flushes++; }
}
export function binding(provider, extra = {}) {
  return { id: provider.id, layer: provider.layer, provider, environment: { kind: "common" }, operation: { kind: "load" }, ownership: { kind: "borrowed" }, ...extra };
}
export function registration(environment = "east", serviceId = "alpha", schema = schemaBody()) {
  return { serviceId, environment, owner: { name: "host", contact: "host@example.org" }, fragmentSlots: [], schema };
}
export function schemaBody() {
  const object = { type: "object", properties: { a: { type: "number" }, b: { type: "number" }, c: { type: "number" } } };
  return { type: "object", properties: {
    cfg: object, missing: { type: "string" }, flag: { type: "string" }, list: { type: "array", items: { type: "number" } },
    secret: { type: "object", properties: { key: { type: "string" } } },
    alias: object, hidden: { ...object, "x-weaver": { sensitive: true } },
    "literal.dot": { type: "string" }, "雪": { type: "string" },
  } };
}
export function options(providers, extra = {}) {
  return { identity: { environment: "east", scopePath: [] },
    schemas: [registration(), registration("east", "beta"), registration("west"), registration("west", "beta")],
    layers: providers.map((provider) => ({ kind: "fixed", layer: provider.layer, providerIds: [provider.id] })),
    providers: providers.map((provider) => binding(provider)), ...extra };
}
export function scopeOptions({ firstGate, secondGate, firstFails = false } = {}) {
  const base = new MemoryProvider("base", "base", { alpha: { cfg: { a: 1, b: 2 }, flag: "base" } });
  const last = new MemoryProvider("last", "last", { alpha: { cfg: { a: 1, c: 3 } } });
  const first = new MemoryProvider("first", "scope", { alpha: { flag: "one" } }, firstGate);
  const second = new MemoryProvider("second", "scope", { alpha: { flag: "two" } }, secondGate);
  if (firstFails) first.entries = { alpha: new Date() };
  const path1 = [{ scopeId: "area,:雪", value: "one,:é" }];
  const path2 = [{ scopeId: "area,:雪", value: "two,:é" }];
  const scopes = [binding(first, { environment: { kind: "environments", environments: ["east"] }, scopePath: path1 }), binding(second, { environment: { kind: "environments", environments: ["east"] }, scopePath: path2 })];
  return { base, last, first, second, path1, path2, input: options([base, first, second, last], {
    layers: [{ kind: "fixed", layer: "base", providerIds: ["base"] }, { kind: "scope", layer: "scope", providerIds: ["first", "second"] }, { kind: "fixed", layer: "last", providerIds: ["last"] }],
    providers: [binding(base), ...scopes, binding(last)],
  }) };
}
