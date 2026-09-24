import { createHash } from "node:crypto";

export const SEED = 0xd6615eed;

const ordinaryShapes = [
  ["string-valid", { type: "string" }, "ok", true],
  ["string-invalid", { type: "string" }, 1, false],
  ["number-valid", { type: "number" }, 1, true],
  ["number-invalid", { type: "number" }, "bad", false],
];

function objectShape(size, valid) {
  const properties = Object.fromEntries(
    Array.from({ length: size }, (_, index) => [`p${index}`, { type: "number" }]),
  );
  const value = Object.fromEntries(
    Array.from({ length: size }, (_, index) => [`p${index}`, index]),
  );
  if (!valid) value[`p${size - 1}`] = "bad";
  return [{ type: "object", properties, additionalProperties: false }, value];
}

function arrayShape(size, valid) {
  const value = Array.from({ length: size }, (_, index) => index);
  if (!valid) value[size - 1] = "bad";
  return [{ type: "array", items: { type: "number" } }, value];
}

function addOrdinary(descriptors) {
  const shapes = [...ordinaryShapes];
  for (const size of [20, 100]) {
    for (const valid of [true, false]) {
      const [schema, value] = objectShape(size, valid);
      shapes.push([`object-${size}-${valid ? "valid" : "invalid"}`, schema, value, valid]);
    }
  }
  for (const size of [100, 1000]) {
    for (const valid of [true, false]) {
      const [schema, value] = arrayShape(size, valid);
      shapes.push([`array-${size}-${valid ? "valid" : "invalid"}`, schema, value, valid]);
    }
  }
  for (const method of ["partial", "effective"]) {
    for (const [name, schema, value, expectedValid] of shapes) {
      descriptors.push({ id: `ordinary:${method}:${name}`, family: "ordinary", variants: "both", kind: "engine", method, schema, value, expectedValid });
    }
  }
  for (const expectedValid of [true, false]) {
    descriptors.push({ id: `ordinary:patch:${expectedValid ? "valid" : "invalid"}`, family: "ordinary", variants: "both", kind: "engine", method: "patch", schema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false }, path: "value", value: expectedValid ? "ok" : 1, expectedValid });
    descriptors.push({ id: `ordinary:server:${expectedValid ? "valid" : "invalid"}`, family: "server-ordinary", variants: "both", kind: "server", serverCase: "ordinary", expectedValid });
  }
}

function branchSchema(keyword, count, position) {
  let branches = Array.from({ length: count }, (_, index) => ({ type: "number", const: index }));
  let value = position === "last" ? count - 1 : 0;
  let valid = true;
  if (position === "none") {
    value = "none";
    valid = false;
  } else if (position === "multiple") {
    branches = [{ type: "number" }, { type: "number" }, ...branches.slice(2)];
    valid = keyword === "anyOf";
  }
  return [{ type: ["number", "string"], [keyword]: branches }, value, valid];
}

function addBranches(descriptors) {
  for (const keyword of ["anyOf", "oneOf"]) {
    for (const count of [2, 8, 32, 128]) {
      for (const position of ["first", "last", "none", "multiple"]) {
        const [schema, value, expectedValid] = branchSchema(keyword, count, position);
        descriptors.push({ id: `${keyword}:${count}:${position}`, family: keyword, variants: "tip", kind: "engine", method: "partial", schema, value, expectedValid, work: count, position });
      }
    }
  }
}

function sharedDiamond(depth, leaf) {
  let schema = leaf;
  for (let index = 0; index < depth; index += 1) schema = { type: leaf.type, allOf: [schema, schema] };
  return schema;
}

function distinctAllOf(count, mode) {
  const branches = Array.from({ length: count }, () => ({ type: "number", minimum: 0, maximum: 100 }));
  let value = 50;
  if (mode === "first-failure") {
    branches[0] = { type: "number", minimum: 51 };
  } else if (mode === "last-failure") {
    branches[count - 1] = { type: "number", maximum: 49 };
  }
  return [{ type: "number", allOf: branches }, value, mode === "all-match"];
}

function addAllOf(descriptors) {
  for (const count of [2, 8, 32, 128]) {
    for (const mode of ["all-match", "first-failure", "last-failure"]) {
      const [schema, value, expectedValid] = distinctAllOf(count, mode);
      descriptors.push({ id: `allOf:distinct:${count}:${mode}`, family: `allOf-distinct-${mode}`, variants: "tip", kind: "engine", method: "partial", schema, value, expectedValid, work: count });
    }
    const branches = Array.from({ length: count }, () => ({ type: "object", properties: { x: { type: "string" } }, additionalProperties: true }));
    descriptors.push({ id: `allOf:equal-distinct:${count}`, family: "allOf-equal-distinct", variants: "tip", kind: "engine", method: "partial", schema: { type: "object", allOf: branches, additionalProperties: true }, value: { x: "ok" }, expectedValid: true, work: count });
  }
  for (const depth of [10, 20, 30, 40]) {
    descriptors.push({ id: `allOf:shared:${depth}`, family: "allOf-shared", variants: "tip", kind: "engine", method: "partial", schema: sharedDiamond(depth, { type: "string", const: "ok" }), value: "ok", expectedValid: true, work: depth });
  }
}

function mixedSchema(depth) {
  let schema = { type: "string", const: "ok" };
  for (let index = 0; index < depth; index += 1) {
    const impossible = { type: "string", const: `no-${index}` };
    if (index % 3 === 0) schema = { type: "string", allOf: [schema, { type: "string", not: impossible }] };
    if (index % 3 === 1) schema = { type: "string", anyOf: [impossible, schema] };
    if (index % 3 === 2) schema = { type: "string", oneOf: [schema, impossible] };
  }
  return schema;
}

function linearShape(depth, valid) {
  let schema = { type: "string" };
  let value = valid ? "ok" : 1;
  for (let index = 0; index < depth; index += 1) {
    schema = { type: "object", properties: { next: schema }, required: ["next"], additionalProperties: false };
    value = { next: value };
  }
  return [schema, value];
}

function addMixedAndScale(descriptors) {
  for (const depth of [8, 32, 128]) {
    for (const expectedValid of [true, false]) descriptors.push({ id: `mixed:${depth}:${expectedValid ? "valid" : "invalid"}`, family: `mixed-${expectedValid ? "valid" : "invalid"}`, variants: "tip", kind: "engine", method: "partial", schema: mixedSchema(depth), value: expectedValid ? "ok" : "bad", expectedValid, work: depth });
  }
  for (const expectedValid of [true, false]) descriptors.push({ id: `not:${expectedValid ? "mismatch" : "match"}`, family: "not", variants: "tip", kind: "engine", method: "partial", schema: { type: "string", not: { type: "string", const: "blocked" } }, value: expectedValid ? "ok" : "blocked", expectedValid });
  for (const depth of [100, 1000, 5000]) {
    for (const expectedValid of [true, false]) {
      const [schema, value] = linearShape(depth, expectedValid);
      descriptors.push({ id: `linear:${depth}:${expectedValid ? "valid" : "invalid"}`, family: `linear-${expectedValid ? "valid" : "invalid"}`, variants: "tip", kind: "engine", method: "partial", schema, value, expectedValid, work: depth });
    }
  }
  for (const shape of ["object", "array"]) {
    for (const size of [10, 100, 1000]) {
      const [plain, value] = shape === "object" ? objectShape(size, true) : arrayShape(size, true);
      for (const wrapped of [false, true]) descriptors.push({ id: `scale:${shape}:${size}:${wrapped ? "composition" : "ordinary"}`, family: `scale-${shape}-${wrapped ? "composition" : "ordinary"}`, variants: "tip", kind: "engine", method: "partial", schema: wrapped ? { ...plain, allOf: [plain] } : plain, value, expectedValid: true, work: size });
    }
  }
}

function addPatches(descriptors) {
  for (const count of [2, 8, 32, 128]) {
    const branches = Array.from({ length: count }, () => ({ type: "object", properties: { x: { type: "string" } }, additionalProperties: true }));
    descriptors.push({ id: `patch:allOf:${count}`, family: "patch-allOf", variants: "tip", kind: "engine", method: "patch", schema: { type: "object", allOf: branches, additionalProperties: true }, path: "x", value: "ok", expectedValid: true, work: count });
  }
  for (const depth of [10, 20, 30, 40]) descriptors.push({ id: `patch:shared:${depth}`, family: "patch-shared", variants: "tip", kind: "engine", method: "patch", schema: sharedDiamond(depth, { type: "object", properties: { x: { type: "string" } }, additionalProperties: true }), path: "x", value: "ok", expectedValid: true, work: depth });
  const leaf = { type: "object", properties: { x: { type: "string", minimum: 1 } }, additionalProperties: true };
  for (const keyword of ["anyOf", "oneOf", "not"]) descriptors.push({ id: `patch:deferral:${keyword}`, family: "patch-deferral", variants: "tip", kind: "engine", method: "patch", schema: { type: "object", properties: { group: { type: "object", [keyword]: keyword === "not" ? leaf : [leaf], properties: { x: { type: "string" } }, additionalProperties: true } }, additionalProperties: false }, path: "group.x", value: "ok", expectedValid: true });
  for (const expectedValid of [true, false]) descriptors.push({ id: `patch:leaf:${expectedValid ? "valid" : "invalid"}`, family: "patch-leaf", variants: "tip", kind: "engine", method: "patch", schema: { type: "object", properties: { leaf: { type: "string", anyOf: [{ type: "string", const: "ok" }] } }, additionalProperties: false }, path: "leaf", value: expectedValid ? "ok" : "bad", expectedValid });
}

function addServer(descriptors) {
  for (const [serverCase, expectedValid] of [["anyOf-valid", true], ["anyOf-invalid", false], ["oneOf-ambiguity", false], ["allOf-valid", true], ["allOf-invalid", false], ["not-rejection", false], ["shared-40", false]]) descriptors.push({ id: `server:${serverCase}`, family: "server-composition", variants: "tip", kind: "server", serverCase, expectedValid });
}

export function caseDescriptors() {
  const descriptors = [];
  addOrdinary(descriptors);
  addBranches(descriptors);
  addAllOf(descriptors);
  addMixedAndScale(descriptors);
  addPatches(descriptors);
  addServer(descriptors);
  return descriptors;
}

function serverDefinition(name, expectedValid) {
  const branches = [{ type: "object", properties: { kind: { type: "string", const: "text" }, value: { type: "string" } }, additionalProperties: true }, { type: "object", properties: { kind: { type: "string", const: "count" }, value: { type: "number" } }, additionalProperties: true }];
  let schema = { type: "object", properties: { kind: { type: "string" }, value: { type: ["string", "number"] } }, additionalProperties: false };
  let initial = { kind: "text", value: "old" };
  let path = "/bench/value";
  let values = expectedValid ? ["a", "b"] : [1];
  if (name.startsWith("anyOf")) schema = { ...schema, anyOf: branches };
  if (name === "oneOf-ambiguity") {
    schema = { ...schema, oneOf: [{ type: "object", properties: { kind: { type: "string", const: "text" } }, additionalProperties: true }, { type: "object", properties: { value: { type: "string" } }, additionalProperties: true }] };
    initial = { kind: "count", value: "old" };
    path = "/bench/kind";
    values = ["text"];
  }
  if (name.startsWith("allOf")) schema = { ...schema, allOf: [{ type: "object", properties: { value: { type: "string" } }, additionalProperties: true }, { type: "object", maxProperties: 2, additionalProperties: true }] };
  if (name === "not-rejection") schema = { ...schema, not: { type: "object", const: { kind: "text", value: "blocked" }, additionalProperties: true } };
  if (name === "not-rejection") values = ["blocked"];
  if (name === "shared-40") schema = sharedDiamond(40, { ...schema, anyOf: [branches[0]] });
  return { schema, initial, path, values };
}

export async function buildFixture(descriptor, api) {
  if (descriptor.kind === "engine") {
    const call = descriptor.method === "partial" ? api.validatePartialConfiguration : descriptor.method === "effective" ? api.validateEffectiveConfiguration : () => api.validateConfigurationPatch(descriptor.schema, descriptor.path, descriptor.value);
    return { async: false, roots: [descriptor.schema, descriptor.value], operation: descriptor.method === "patch" ? call : () => call(descriptor.schema, descriptor.value), effects: () => ({}) };
  }
  const definition = serverDefinition(descriptor.serverCase, descriptor.expectedValid);
  const provider = api.createInMemoryStorageProvider({ id: "bench", layer: "platform", initialEntries: { bench: definition.initial } });
  let writes = 0;
  const originalWrite = provider.write.bind(provider);
  provider.write = async (...args) => { const result = await originalWrite(...args); if (result.success) writes += 1; return result; };
  const service = await api.createWeaverConfigService({ providers: [provider], environment: "bench" });
  const registry = api.createSchemaRegistry({ configService: service });
  const registration = await registry.register({ serviceId: "bench", environment: "bench", owner: { name: "benchmark", contact: "bench@example.com" }, schema: definition.schema, fragmentSlots: [] });
  if (!registration.success) throw new Error(`registration failed: ${JSON.stringify(registration)}`);
  let notifications = 0;
  service.onDelta(() => { notifications += 1; });
  let revisions = 0;
  let index = 0;
  const operation = async () => {
    const before = service.revision;
    const result = await service.patchRegisteredPath("platform", definition.path, definition.values[index++ % definition.values.length], { schemaRegistry: registry });
    if (service.revision !== before) revisions += 1;
    return result;
  };
  const effects = async () => ({ writes, notifications, revisions, entry: (await provider.load()).entries, prototype: Object.getPrototypeOf(definition.initial) === Object.prototype });
  return { async: true, roots: [definition.schema, definition.initial], operation, effects };
}

export function fingerprint(roots) {
  const hash = createHash("sha256");
  const seen = new Map();
  const stack = roots.map((value, index) => [value, `$${index}`]).reverse();
  while (stack.length > 0) {
    const [value, path] = stack.pop();
    if (value === null || typeof value !== "object") { hash.update(`${path}:${typeof value}:${String(value)};`); continue; }
    if (seen.has(value)) { hash.update(`${path}:ref:${seen.get(value)};`); continue; }
    seen.set(value, seen.size);
    const keys = Reflect.ownKeys(value);
    hash.update(`${path}:${Array.isArray(value) ? "array" : "object"}:${keys.map(String).join(",")};`);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      hash.update(`${String(key)}:${descriptor.enumerable}:${descriptor.configurable}:${"writable" in descriptor ? descriptor.writable : "accessor"};`);
      if ("value" in descriptor) stack.push([descriptor.value, `${path}.${String(key)}`]);
    }
  }
  return hash.digest("hex");
}
