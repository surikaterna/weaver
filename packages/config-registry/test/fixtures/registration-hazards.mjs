import { fragment, service } from "./requests.mjs";

function requestFor(kind) {
  const request = kind === "fragment" ? fragment() : service();
  request.schema = { type: "object", properties: { name: { type: "string", default: { payload: "plain" } } } };
  return request;
}

function hazard(kind, name, change) {
  const request = requestFor(kind);
  const context = { actor: "host" };
  let calls = 0;
  const getter = () => { calls++; throw new Error("input getter must not run"); };
  const returning = value => () => { calls++; return value; };
  change(request, context, getter, returning);
  return { name: `${kind}: ${name}`, request, context, calls: () => calls };
}

function accessor(target, key, getter, enumerable = true) {
  Object.defineProperty(target, key, { enumerable, configurable: true, get: getter });
}

export function registrationHazards(kind) {
  const changes = [
    ["serviceId getter", (q, _c, g) => accessor(q, "serviceId", g)],
    ["providerId/discriminator getter", (q, _c, g) => accessor(q, "providerId", g)],
    ["environment getter", (q, _c, g) => accessor(q, "environment", g)],
    ["owner.name getter", (q, _c, g) => accessor(q.owner, "name", g)],
    ["nested default.payload getter", (q, _c, g) => accessor(q.schema.properties.name.default, "payload", g)],
    ["reported returning serviceId getter", (q, _c, _g, returning) => accessor(q, "serviceId", returning("svc"))],
    ["reported returning owner.name getter", (q, _c, _g, returning) => accessor(q.owner, "name", returning("owner"))],
    ["reported returning default.payload getter", (q, _c, _g, returning) => accessor(q.schema.properties.name.default, "payload", returning("plain"))],
    ["hidden accessor", (q, _c, g) => accessor(q.owner, "hidden", g, false)],
    ["context.actor getter", (_q, c, g) => accessor(c, "actor", g)],
    ["context.subject hidden getter", (_q, c, g) => accessor(c, "subject", g, false)],
    ["symbol key", q => { q[Symbol("hidden")] = "plain"; }],
    ["symbol value", q => { q.schema.properties.name.default.payload = Symbol("value"); }],
    ["custom prototype", q => Object.setPrototypeOf(q, { extra: true })],
    ["inherited required getter", (q, _c, g) => { delete q.serviceId; const prototype = {}; accessor(prototype, "serviceId", g); Object.setPrototypeOf(q, prototype); }],
    ["hidden data field", q => Object.defineProperty(q.owner, "contact", { value: "hidden", enumerable: false })],
    ["prototype manipulation key", q => Object.defineProperty(q.schema.properties.name.default, "__proto__", { value: {}, enumerable: true })],
    ["constructor key", q => { q.schema.properties.name.default.constructor = "unsafe"; }],
    ["prototype key", q => { q.schema.properties.name.default.prototype = "unsafe"; }],
    ["object cycle", q => { q.schema.properties.name.default.payload = q.schema; }],
    ["array cycle", q => { const array = []; array.push(array); q.schema.properties.name.default.payload = array; }],
    ["function/toJSON", q => { q.schema.properties.name.default.toJSON = () => { throw new Error("coercion"); }; }],
    ["bigint", q => { q.schema.properties.name.default.payload = 1n; }],
    ["nonfinite number", q => { q.schema.properties.name.default.payload = NaN; }],
    ["exotic Date", q => { q.schema.properties.name.default.payload = new Date(); }],
    ["exotic Map", q => { q.schema.properties.name.default.payload = new Map(); }],
    ["context symbol", (_q, c) => { c[Symbol("context")] = true; }],
    ["array extra string", q => arrayChange(q, array => { array.extra = true; })],
    ["array symbol", q => arrayChange(q, array => { array[Symbol("metadata")] = true; })],
    ["array hidden metadata", q => arrayChange(q, array => Object.defineProperty(array, "extra", { value: true }))],
    ["array metadata getter", (q, _c, g) => arrayChange(q, array => accessor(array, "extra", g))],
    ["array hidden accessor", (q, _c, g) => arrayChange(q, array => accessor(array, "extra", g, false))],
    ["shared array metadata getter", (q, _c, g) => { const array = ["plain"]; accessor(array, "extra", g); q.schema.properties.name.default.payload = { one: array, two: array }; }],
    ["array index getter", (q, _c, g) => arrayChange(q, array => accessor(array, "0", g))],
    ["array hidden index", q => arrayChange(q, array => Object.defineProperty(array, "0", { value: "hidden", enumerable: false }))],
    ["sparse array", q => arrayChange(q, array => { delete array[0]; })],
    ["noncanonical array index", q => arrayChange(q, array => { array["01"] = true; })],
    ["inherited array metadata", (q, _c, g) => arrayChange(q, array => { const prototype = Object.create(Array.prototype); accessor(prototype, "extra", g); Object.setPrototypeOf(array, prototype); })],
  ];
  if (kind === "service") changes.push(
    ["fragmentSlots[0].slotPath getter", (q, _c, g) => accessor(q.fragmentSlots[0], "slotPath", g)],
    ["reported returning fragmentSlots[0].slotPath getter", (q, _c, _g, returning) => accessor(q.fragmentSlots[0], "slotPath", returning("/plugins"))],
    ["fragmentSlots metadata getter", (q, _c, g) => accessor(q.fragmentSlots, "metadata", g)],
  );
  else changes.push(["fragment slotPath getter", (q, _c, g) => accessor(q, "slotPath", g)]);
  return changes.map(([name, change]) => hazard(kind, name, change));
}

function arrayChange(request, change) {
  const array = ["plain"];
  change(array);
  request.schema.properties.name.default.payload = array;
}

export function proxyHazard() {
  let reflections = 0;
  let reads = 0;
  const request = new Proxy(service(), {
    getPrototypeOf() { reflections++; throw Object.create(null); },
    get() { reads++; throw new Error("property read"); },
  });
  return { name: "uncertain Proxy reflection", request, context: undefined, calls: () => reads, reflections: () => reflections };
}

export function assertRejected(assert, result) {
  assert.equal(result.success, false);
  assert.equal(result.isNewSchema, false);
  assert.equal(result.hasBreakingChanges, false);
  assert.equal(result.error.code, "VALIDATION_ERROR");
}
