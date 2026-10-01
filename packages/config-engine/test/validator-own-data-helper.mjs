import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("tsup"))("esbuild");
const source = fileURLToPath(new URL("../src/", import.meta.url));

export async function loadPrivateSafetyModules() {
  const bundle = await esbuild.build({
    stdin: {
      contents: `export * from "./schema-validation-schema-stability.ts";
export * from "./deep-equal.ts";
export * from "./path.ts";`,
      resolveDir: source,
      sourcefile: "validator-own-data-private-tests.mjs",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}

// The callback must be synchronous; assertions and runner output happen after restoration.
export function underNumericTrap(prototype, index, callback) {
  const key = String(index);
  const previous = Object.getOwnPropertyDescriptor(prototype, key);
  let getters = 0;
  let setters = 0;
  let value;
  try {
    Object.defineProperty(prototype, key, {
      configurable: true,
      get() { getters++; return undefined; },
      set(data) {
        setters++;
        Object.defineProperty(this, key, {
          value: data, configurable: true, enumerable: true, writable: true,
        });
      },
    });
    value = callback();
  } finally {
    if (previous === undefined) delete prototype[key];
    else Object.defineProperty(prototype, key, previous);
  }
  return { value, getters, setters };
}

export async function probeCanonicalRoots() {
  const engine = await import("../dist/index.js");
  const schema = {
    type: "object", additionalProperties: false,
    properties: { enabled: {
      type: "boolean", anyOf: [{ type: "boolean", const: true }, { type: "boolean", const: false }],
    } },
  };
  const roots = [
    ["effective", () => engine.validateEffectiveConfiguration(schema, { enabled: true })],
    ["partial", () => engine.validatePartialConfiguration(schema, { enabled: true })],
    ["patch", () => engine.validateConfigurationPatch(schema, "enabled", true)],
  ];
  let safe = true;
  for (const [name, prototype] of [["object", Object.prototype], ["array", Array.prototype]]) {
    for (const index of [0, 1, 700]) {
      for (const [root, invoke] of roots) {
        const { value, getters, setters } = underNumericTrap(prototype, index, invoke);
        console.log(JSON.stringify({ prototype: name, index, root, getters, setters, result: value }));
        safe = getters === 0 && setters === 0 && value.valid && safe;
      }
    }
  }
  return safe;
}

function validatorOwned(length, make) {
  const values = [];
  for (let index = 0; index < length; index++) {
    Object.defineProperty(values, String(index), {
      value: make(index), writable: true, enumerable: true, configurable: true,
    });
  }
  return values;
}

function validatorPrototype(counter) {
  const prototype = Object.create(null);
  for (const key of ["type", "properties", "items", "anyOf", "oneOf", "allOf", "not",
    "required", "default", "const", "enum", "minimum", "pattern", "additionalProperties",
    "0", "1", "700", "example", Symbol.toStringTag, Symbol.iterator]) {
    Object.defineProperty(prototype, key, { get() { counter.calls++; return { type: "number" }; } });
  }
  return prototype;
}

function validatorCustom(counter) {
  const prototype = validatorPrototype(counter);
  const leaf = Object.setPrototypeOf({ type: "boolean" }, prototype);
  const types = Object.setPrototypeOf(["boolean", "null"], prototype);
  const branches = Object.setPrototypeOf([leaf], prototype);
  const tuple = Object.setPrototypeOf([leaf], prototype);
  const properties = Object.setPrototypeOf({ flag: { type: types, allOf: branches }, list: { type: "array", items: tuple } }, prototype);
  return Object.setPrototypeOf({ type: "object", properties, additionalProperties: false }, prototype);
}

function validatorWrapped(engine, name, schema, good, bad) {
  const wrapper = { type: "object", properties: { cfg: schema }, additionalProperties: false };
  return [
    { name: `${name}/effective+`, invoke: () => engine.validateEffectiveConfiguration(wrapper, { cfg: good }), valid: true },
    { name: `${name}/partial+`, invoke: () => engine.validatePartialConfiguration(wrapper, { cfg: good }), valid: true },
    { name: `${name}/patch+`, invoke: () => engine.validateConfigurationPatch(wrapper, "cfg", good), valid: true },
    { name: `${name}/effective-`, invoke: () => engine.validateEffectiveConfiguration(wrapper, { cfg: bad }), valid: false },
    { name: `${name}/partial-`, invoke: () => engine.validatePartialConfiguration(wrapper, { cfg: bad }), valid: false },
    { name: `${name}/patch-`, invoke: () => engine.validateConfigurationPatch(wrapper, ["cfg"], bad), valid: false },
  ];
}

function validatorCases(engine) {
  const composed = { type: "boolean", anyOf: [{ type: "boolean", const: true }, { type: "boolean", const: false }],
    oneOf: [{ type: "boolean", const: true }, { type: "boolean", const: false }], allOf: [{ type: "boolean" }], not: { type: "boolean", const: false } };
  const literal = { nested: [{ leaf: 1 }] };
  const equal = { type: "object", properties: { nested: { type: "array", items: { type: "object", additionalProperties: true } } },
    const: literal, enum: [literal, { nested: [] }], additionalProperties: false };
  const object = { type: "object", properties: { fixed: { type: "string" } }, required: ["fixed"],
    patternProperties: { "^ok": { type: "boolean" } }, additionalProperties: { type: "number" }, minProperties: 2, maxProperties: 3 };
  return [
    ...validatorWrapped(engine, "all-composition", composed, true, false),
    ...validatorWrapped(engine, "decimal", { type: "number", minimum: 0, maximum: 1, exclusiveMinimum: -1, exclusiveMaximum: 2, multipleOf: 0.1 }, 0.3, 0.35),
    ...validatorWrapped(engine, "unicode-pattern", { type: "string", minLength: 1, maxLength: 2, pattern: "^a" }, "a😀", "bbb"),
    ...validatorWrapped(engine, "deep-const-enum", equal, { nested: [{ leaf: 1 }] }, { nested: [{ leaf: 2 }] }),
    ...validatorWrapped(engine, "unique", { type: "array", items: { type: "object", additionalProperties: true }, uniqueItems: true, minItems: 2, maxItems: 3 }, [{ x: 1 }, { x: 2 }], [{ x: 1 }, { x: 1 }]),
    ...validatorWrapped(engine, "pattern-additional", object, { fixed: "ok", okFlag: true, extra: 1 }, { fixed: 2, okFlag: 2, extra: "bad" }),
    ...validatorWrapped(engine, "unknown-type", { type: "object", properties: { flag: { type: "boolean" } }, additionalProperties: false }, { flag: true }, { unknown: true }),
  ];
}

function validatorLargeCases(engine) {
  const names = validatorOwned(702, (index) => `p${index}`);
  const properties = Object.fromEntries(names.map((key) => [key, { type: "number" }]));
  const value = Object.fromEntries(names.map((key, index) => [key, index]));
  const wrong = Object.fromEntries(names.map((key) => [key, "wrong"]));
  const schema = { type: "object", properties, required: names, additionalProperties: false };
  const any = { type: "boolean", anyOf: validatorOwned(702, (index) => ({ type: "boolean", const: index === 701 })) };
  let deepSchema = { type: "boolean" }, deepValue = true;
  for (let index = 0; index < 702; index++) {
    deepSchema = { type: "object", properties: { next: deepSchema }, additionalProperties: false };
    deepValue = { next: deepValue };
  }
  return [
    ...validatorWrapped(engine, "702-errors", schema, value, wrong),
    ...validatorWrapped(engine, "702-branches", any, true, "wrong"),
    ...validatorWrapped(engine, "702-paths", deepSchema, deepValue, { next: "wrong" }),
    { name: "702-required", invoke: () => engine.validateEffectiveConfiguration(schema, {}), valid: false, errors: 702 },
    { name: "702-unknown", invoke: () => engine.validatePartialConfiguration({ type: "object", additionalProperties: false }, value), valid: false, errors: 702 },
    { name: "702-string-path", invoke: () => engine.validateConfigurationPatch(deepSchema, names.map(() => "next").join("."), true), valid: true },
    { name: "702-array-path", invoke: () => engine.validateConfigurationPatch(deepSchema, names.map(() => "next"), "wrong"), valid: false },
  ];
}

function validatorMalformedCases(engine, counter) {
  const accessor = () => { counter.calls++; return "never"; };
  const unsafe = { type: "boolean", "x-weaver": { nested: {} } };
  Object.defineProperty(unsafe["x-weaver"].nested, "hidden", { get: accessor });
  const value = {}; Object.defineProperty(value, "hidden", { get: accessor });
  const path = ["cfg"]; Object.defineProperty(path, "0", { get: accessor });
  const options = {}; Object.defineProperty(options, "path", { get: accessor });
  const tupleHole = []; tupleHole.length = 2; tupleHole[1] = { type: "boolean" };
  const typeHole = []; typeHole.length = 2; typeHole[0] = "boolean";
  const branchHole = []; branchHole.length = 2; branchHole[0] = { type: "boolean" };
  const sparse = []; sparse.length = 2; sparse[0] = true;
  const cycle = {}; cycle.self = cycle;
  const literal = Object.setPrototypeOf({}, validatorPrototype(counter));
  const common = { type: "object", properties: { cfg: { type: "boolean" } } };
  return [
    { name: "hidden-schema-accessor", invoke: () => engine.validateEffectiveConfiguration(unsafe, true), valid: false, code: "invalid-schema" },
    { name: "hidden-value-accessor", invoke: () => engine.validatePartialConfiguration({ type: "object" }, value), valid: false, code: "invalid-value" },
    { name: "own-path-accessor", invoke: () => engine.validateConfigurationPatch(common, path, true), valid: false, code: "invalid-path" },
    { name: "own-options-accessor", invoke: () => engine.validatePartialConfiguration(common, {}, options), valid: false, code: "invalid-path" },
    { name: "tuple-hole", invoke: () => engine.validatePartialConfiguration({ type: "array", items: tupleHole }, []), valid: false, code: "invalid-schema" },
    { name: "type-hole", invoke: () => engine.validatePartialConfiguration({ type: typeHole }, true), valid: false, code: "invalid-schema" },
    { name: "branch-hole", invoke: () => engine.validatePartialConfiguration({ type: "boolean", anyOf: branchHole }, true), valid: false, code: "invalid-schema" },
    { name: "candidate-hole", invoke: () => engine.validatePartialConfiguration({ type: "array", items: { type: "boolean" } }, sparse), valid: false, code: "invalid-value" },
    { name: "value-cycle", invoke: () => engine.validatePartialConfiguration({ type: "object", additionalProperties: true }, cycle), valid: false, code: "invalid-value" },
    { name: "literal-prototype", invoke: () => engine.validatePartialConfiguration({ type: "object", additionalProperties: true }, literal), valid: false, code: "invalid-value" },
    { name: "default-data-role", invoke: () => engine.validateEffectiveConfiguration({ type: "object", default: literal }, undefined), valid: false, code: "invalid-schema" },
    { name: "reserved-string-path", invoke: () => engine.validateConfigurationPatch(common, "constructor", true), valid: false, code: "invalid-path" },
    { name: "numeric-string-path", invoke: () => engine.validateConfigurationPatch({ type: "array", items: { type: "boolean" } }, "[0]", true), valid: true },
    { name: "tuple-absent", invoke: () => engine.validateConfigurationPatch({ type: "array", items: [{ type: "boolean" }] }, [1], "untyped"), valid: true },
    { name: "required", invoke: () => engine.validateEffectiveConfiguration({ type: "object", required: ["flag"] }, {}), valid: false, code: "missing-required" },
  ];
}

function validatorRejected(engine, name, schema, value, code) {
  return [
    { name: `${name}/effective`, invoke: () => engine.validateEffectiveConfiguration(schema, value), valid: false, code },
    { name: `${name}/partial`, invoke: () => engine.validatePartialConfiguration(schema, value), valid: false, code },
    { name: `${name}/patch`, invoke: () => engine.validateConfigurationPatch(schema, [], value), valid: false, code },
  ];
}

function validatorBoundaryCases(engine, counter) {
  const spy = () => { counter.calls++; return { type: "boolean" }; };
  const schema = { type: "boolean" }; Object.defineProperty(schema, "type", { get: spy });
  const map = {}; Object.defineProperty(map, "flag", { get: spy, enumerable: true });
  const items = [{}]; Object.defineProperty(items, "0", { get: spy });
  const tag = { type: "boolean" }; Object.defineProperty(tag, Symbol.toStringTag, { get: spy });
  const ownValue = {}; Object.defineProperty(ownValue, "hidden", { get: spy });
  const custom = Object.setPrototypeOf({ type: "boolean" }, validatorPrototype(counter));
  const mixed = { type: "object", properties: { first: custom, second: { type: "object", default: custom } } };
  const inheritedMap = Object.create(validatorPrototype(counter));
  const inherited = Object.setPrototypeOf({ type: "object", properties: inheritedMap }, validatorPrototype(counter));
  const cycle = { type: "boolean" }; cycle.anyOf = [cycle];
  const enumHole = []; enumHole.length = 2; enumHole[0] = true;
  const requiredHole = []; requiredHole.length = 2; requiredHole[0] = "flag";
  return [
    ...validatorRejected(engine, "own-type-accessor", schema, true, "invalid-schema"),
    ...validatorRejected(engine, "own-map-accessor", { type: "object", properties: map }, {}, "invalid-schema"),
    ...validatorRejected(engine, "own-tuple-accessor", { type: "array", items }, [], "invalid-schema"),
    ...validatorRejected(engine, "own-branch-accessor", { type: "boolean", anyOf: items }, true, "invalid-schema"),
    ...validatorRejected(engine, "own-symbol-tag", tag, true, "invalid-schema"),
    ...validatorRejected(engine, "own-value-accessor", { type: "object" }, ownValue, "invalid-value"),
    ...validatorRejected(engine, "shared-role-no-exemption", mixed, {}, "invalid-schema"),
    ...validatorRejected(engine, "schema-cycle", cycle, true, "invalid-schema"),
    ...validatorRejected(engine, "enum-hole", { type: "boolean", enum: enumHole }, true, "invalid-schema"),
    ...validatorRejected(engine, "required-hole", { type: "object", required: requiredHole }, {}, "invalid-schema"),
    ...validatorRejected(engine, "invalid-pattern", { type: "string", pattern: "(a+)+$" }, "a", "invalid-schema"),
    ...validatorRejected(engine, "invalid-multiple", { type: "number", multipleOf: 0 }, 1, "invalid-schema"),
    ...validatorRejected(engine, "inherited-member-no-grant", inherited, { example: true }, "unknown-property"),
    ...validatorRejected(engine, "data-date", { type: "object", additionalProperties: true }, new Date(), "invalid-value"),
    ...validatorRejected(engine, "symbol-value", { type: "object", additionalProperties: true }, { value: Symbol("data") }, "invalid-value"),
    ...validatorRejected(engine, "noncoercive-required", { type: "object", required: [Object.create(null)] }, {}, "invalid-schema"),
    ...validatorRejected(engine, "noncoercive-bound", { type: "number", minimum: Object.create(null) }, 1, "invalid-schema"),
    ...validatorRejected(engine, "noncoercive-pattern", { type: "string", pattern: Object.create(null) }, "a", "invalid-schema"),
  ];
}

function validatorAdditionalCases(engine, counter) {
  const child = Object.setPrototypeOf({ type: "string" }, validatorPrototype(counter));
  const root = { type: "object", additionalProperties: child };
  const nested = { type: "object", additionalProperties: Object.setPrototypeOf({ type: "object", additionalProperties: child }, validatorPrototype(counter)) };
  const accessor = Object.setPrototypeOf({ type: "string" }, validatorPrototype(counter));
  Object.defineProperty(accessor, "minLength", { get() { counter.calls++; return 0; } });
  const cases = validatorWrapped(engine, "additional-nested", nested, { extra: { value: "ok" } }, { extra: { value: 1 } });
  for (const [name, value, valid] of [["good", "ok", true], ["bad", 1, false]]) {
    cases.push({ name: `additional-root/effective-${name}`, invoke: () => engine.validateEffectiveConfiguration(root, { extra: value }), valid });
    cases.push({ name: `additional-root/partial-${name}`, invoke: () => engine.validatePartialConfiguration(root, { extra: value }), valid });
    cases.push({ name: `additional-root/patch-${name}`, invoke: () => engine.validateConfigurationPatch(root, ["extra"], value), valid });
  }
  for (const fixture of cases) if (!fixture.valid) fixture.code = "invalid-type";
  return [...cases,
    ...validatorRejected(engine, "additional-own-accessor", { type: "object", additionalProperties: accessor }, { extra: "ok" }, "invalid-schema"),
    ...validatorRejected(engine, "additional-default-role", { type: "object", default: child, additionalProperties: child }, {}, "invalid-schema"),
    ...validatorRejected(engine, "additional-default-reverse", { type: "object", additionalProperties: child, default: child }, {}, "invalid-schema"),
    ...validatorRejected(engine, "unsupported-definitions-data", { type: "object", additionalProperties: true, definitions: { ignored: child } }, {}, "invalid-schema"),
    ...validatorWrapped(engine, "additional-boolean", { type: "object", additionalProperties: false }, {}, { extra: "unknown" }),
  ];
}

function validatorPathError(path, segments = []) {
  return { valid: false, errors: [{ code: "invalid-path", path: segments.length ? "$.base[2]" : "$", segments,
    message: `Invalid path: Unmatched '[' in "${path}"` }] };
}

function validatorStringPathCases(engine) {
  const schema = { type: "object", additionalProperties: true }, cases = [];
  for (const path of ["[", "a".repeat(699) + "["]) {
    const result = validatorPathError(path);
    cases.push({ name: `terminal-bracket/${path.length}/patch`, invoke: () => engine.validateConfigurationPatch(schema, path, true), valid: false, result });
    cases.push({ name: `terminal-bracket/${path.length}/based-patch`, invoke: () => engine.validateConfigurationPatch(schema, path, true, { path: ["base", 2] }), valid: false, result: validatorPathError(path, ["base", 2]) });
    cases.push({ name: `terminal-bracket/${path.length}/effective-options`, invoke: () => engine.validateEffectiveConfiguration(schema, {}, { path }), valid: false, result });
    cases.push({ name: `terminal-bracket/${path.length}/partial-options`, invoke: () => engine.validatePartialConfiguration(schema, {}, { path }), valid: false, result });
    cases.push({ name: `terminal-bracket/${path.length}/patch-options`, invoke: () => engine.validateConfigurationPatch(schema, "flag", true, { path }), valid: false, result });
  }
  return cases;
}

function validatorZero(prototype, index, invoke, assert, label) {
  const outcome = underNumericTrap(prototype, index, invoke);
  assert.equal(outcome.getters, 0, `${label}: inherited getter`);
  assert.equal(outcome.setters, 0, `${label}: inherited setter`);
  return outcome.value;
}

function validatorCase(prototype, index, fixture, assert) {
  const expected = fixture.invoke();
  assert.equal(expected.valid, fixture.valid, `${fixture.name}: ordinary result`);
  if (fixture.code) assert.equal(expected.errors[0].code, fixture.code, fixture.name);
  if (fixture.errors) assert.equal(expected.errors.length, fixture.errors, fixture.name);
  if (fixture.result) assert.deepEqual(expected, fixture.result, fixture.name);
  const result = validatorZero(prototype, index, fixture.invoke, assert, fixture.name);
  assert.deepEqual(result, expected, fixture.name);
}

function validatorMutations(schema, counter) {
  return [
    () => { schema.properties.x.minimum = 2; },
    () => { schema.properties.x.default = 2; },
    () => { schema.properties.x.const = 2; },
    () => { schema.properties.x.enum = [2]; },
    () => { schema.properties.x.enum[0] = 1; },
    () => { schema.properties.x.anyOf = [{ type: "number", minimum: 0 }, { type: "number", minimum: 10 }]; },
    () => { schema.properties.x.anyOf[0].minimum = 3; },
    () => { schema.properties.arr.items = [{ type: "number" }]; },
    () => { schema.properties.arr.items[0] = { type: "string" }; },
    () => { schema.required[0] = "missing"; },
    () => { Object.defineProperty(schema.properties.x, "minimum", { enumerable: false }); },
    () => { Object.setPrototypeOf(schema.properties.x, validatorPrototype(counter)); },
    () => { Object.setPrototypeOf(schema.properties, validatorPrototype(counter)); },
    () => { Object.preventExtensions(schema.properties.x); },
    () => { Object.defineProperty(schema.properties.x, "minimum", { get() { counter.calls++; return 0; } }); },
  ];
}

function validatorCached(engine, factory, prototype, index, assert, counter) {
  const schema = { type: "object", properties: { x: { type: "number", default: 1 }, arr: { type: "array", items: { type: "number" } } },
    required: ["x"], additionalProperties: false };
  const options = { path: ["base"] };
  const session = validatorZero(prototype, index, () => factory(schema, options), assert, "session-create");
  const checks = [
    [() => session.validateEffective({ arr: [1] }), () => engine.validateEffectiveConfiguration(schema, { arr: [1] }, options)],
    [() => session.validatePartial({ x: 1, arr: [1] }), () => engine.validatePartialConfiguration(schema, { x: 1, arr: [1] }, options)],
    [() => session.validatePatch("x", 1), () => engine.validateConfigurationPatch(schema, "x", 1, options)],
  ];
  const compare = () => {
    for (const [cached, fresh] of checks) {
      assert.deepEqual(validatorZero(prototype, index, cached, assert, "cached"), fresh());
      assert.deepEqual(validatorZero(prototype, index, cached, assert, "cached-repeat"), fresh());
    }
  };
  compare();
  for (const mutate of validatorMutations(schema, counter)) { mutate(); compare(); }
}

function validatorLiteralCached(engine, factory, prototype, index, assert) {
  const schema = { type: "array", items: { type: "object", additionalProperties: true },
    const: [{ x: 1 }], enum: [[{ x: 1 }]], default: [{ x: 1 }] };
  const session = validatorZero(prototype, index, () => factory(schema), assert, "literal-session");
  const changes = [() => {}, () => { schema.const[0].x = 2; }, () => { schema.enum[0][0].x = 2; },
    () => { schema.default[0].x = 2; }, () => { Object.freeze(schema.const[0]); }];
  for (const change of changes) {
    change();
    const effective = validatorZero(prototype, index, () => session.validateEffective(undefined), assert, "literal-default-cache");
    const partial = validatorZero(prototype, index, () => session.validatePartial([{ x: 1 }]), assert, "literal-enum-cache");
    const patch = validatorZero(prototype, index, () => session.validatePatch([], [{ x: 1 }]), assert, "literal-const-cache");
    assert.deepEqual(effective, engine.validateEffectiveConfiguration(schema, undefined));
    assert.deepEqual(partial, engine.validatePartialConfiguration(schema, [{ x: 1 }]));
    assert.deepEqual(patch, engine.validateConfigurationPatch(schema, [], [{ x: 1 }]));
  }
}

function validatorAdditionalCached(engine, factory, prototype, index, assert, counter) {
  const child = { type: "object", properties: { value: { type: "string" } }, additionalProperties: false };
  const schema = { type: "object", additionalProperties: child }, options = { path: ["base"] };
  const session = validatorZero(prototype, index, () => factory(schema, options), assert, "additional-session");
  const changes = [() => {},
    () => { child.properties.value.type = "number"; },
    () => { child.properties.value = Object.setPrototypeOf({ type: "string" }, validatorPrototype(counter)); },
    () => { Object.defineProperty(child.properties, "value", { enumerable: false }); },
    () => { Object.setPrototypeOf(child, validatorPrototype(counter)); },
    () => { Object.setPrototypeOf(schema, validatorPrototype(counter)); },
    () => { Object.preventExtensions(child); },
    () => { schema.additionalProperties = Object.setPrototypeOf({ type: "object", additionalProperties: Object.setPrototypeOf({ type: "string" }, validatorPrototype(counter)) }, validatorPrototype(counter)); },
    () => { Object.defineProperty(schema.additionalProperties, "properties", { value: Object.setPrototypeOf({ value: { type: "number" } }, validatorPrototype(counter)), configurable: true, enumerable: true, writable: true }); },
    () => { schema.additionalProperties = { type: "string" }; },
    () => { schema.additionalProperties = false; }, () => { schema.additionalProperties = true; },
    () => { schema.additionalProperties = { type: "object", properties: { value: { type: "string" } }, additionalProperties: false }; },
    () => { Object.defineProperty(schema.additionalProperties, "type", { get() { counter.calls++; return "object"; } }); },
  ];
  const validSteps = [true, false, true, true, true, true, true, true, false, false, false, true, true, false];
  for (const [step, change] of changes.entries()) {
    change();
    const checks = [
      [() => session.validateEffective({ extra: { value: "ok" } }), () => engine.validateEffectiveConfiguration(schema, { extra: { value: "ok" } }, options)],
      [() => session.validatePartial({ extra: { value: "ok" } }), () => engine.validatePartialConfiguration(schema, { extra: { value: "ok" } }, options)],
      [() => session.validatePatch(["extra", "value"], "ok"), () => engine.validateConfigurationPatch(schema, ["extra", "value"], "ok", options)],
    ];
    for (const [cached, fresh] of checks) {
      const expected = fresh();
      assert.equal(expected.valid, validSteps[step], `additional mutation ${step}`);
      assert.deepEqual(validatorZero(prototype, index, cached, assert, "additional-cache"), expected);
      assert.deepEqual(validatorZero(prototype, index, cached, assert, "additional-repeat"), expected);
    }
  }
}

function validatorCachedStringPaths(engine, factory, prototype, index, assert) {
  const schema = { type: "object", properties: { flag: { type: "boolean" } }, additionalProperties: true };
  const session = factory(schema, { path: ["base", 2] });
  assert.equal(session.validatePartial({ flag: true }).valid, true);
  for (const path of ["[", "a".repeat(699) + "["]) {
    const badOptions = validatorZero(prototype, index, () => factory(schema, { path }), assert, "terminal-options-session");
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.deepEqual(validatorZero(prototype, index, () => session.validatePatch(path, true), assert, "terminal-cached-patch"), validatorPathError(path, ["base", 2]));
      assert.deepEqual(validatorZero(prototype, index, () => badOptions.validateEffective({}), assert, "terminal-cached-effective-options"), validatorPathError(path));
      assert.deepEqual(validatorZero(prototype, index, () => badOptions.validatePartial({}), assert, "terminal-cached-partial-options"), validatorPathError(path));
      assert.deepEqual(validatorZero(prototype, index, () => badOptions.validatePatch("flag", true), assert, "terminal-cached-patch-options"), validatorPathError(path));
    }
    assert.equal(session.validatePatch("flag", true).valid, true, "malformed path must not invalidate the session");
  }
}

function validatorControls(prototype, index, assert) {
  const scratch = validatorOwned(index, (value) => value);
  const hole = []; hole.length = index + 1;
  const outcome = underNumericTrap(prototype, index, () => { scratch.push("unsafe"); return hole[index]; });
  assert.equal(outcome.getters, 1, "missing tuple negative control");
  assert.equal(outcome.setters, 1, "push negative control");
}

export function checkValidatorOwnData(engine, factory, assert, prototypeNames = ["object", "array"], indices = [0, 1, 700]) {
  const counter = { calls: 0 };
  const custom = validatorCustom(counter);
  const branded = new Date(); Object.defineProperty(branded, "type", { value: "boolean", enumerable: true });
  const inheritedOnly = Object.create(validatorPrototype(counter));
  const cases = [...validatorCases(engine), ...validatorLargeCases(engine), ...validatorMalformedCases(engine, counter), ...validatorBoundaryCases(engine, counter), ...validatorAdditionalCases(engine, counter), ...validatorStringPathCases(engine),
    ...validatorWrapped(engine, "custom-schema-roles", custom, { flag: true, list: [true, "untyped"] }, { flag: "wrong", list: [1] }),
    ...validatorWrapped(engine, "own-branded-schema", branded, true, "wrong"),
    { name: "inherited-type-no-grant", invoke: () => engine.validatePartialConfiguration(inheritedOnly, true), valid: false, code: "invalid-schema" }];
  for (const name of prototypeNames) {
    const prototype = name === "object" ? Object.prototype : Array.prototype;
    for (const index of indices) {
      validatorControls(prototype, index, assert);
      for (const fixture of cases) validatorCase(prototype, index, fixture, assert);
      validatorCached(engine, factory, prototype, index, assert, counter);
      validatorLiteralCached(engine, factory, prototype, index, assert);
      validatorAdditionalCached(engine, factory, prototype, index, assert, counter);
      validatorCachedStringPaths(engine, factory, prototype, index, assert);
    }
  }
  assert.equal(counter.calls, 0, "own/prototype/brand accessors never execute");
  return cases.length;
}

export const validatorFixtureSource = [underNumericTrap, validatorOwned, validatorPrototype, validatorCustom,
  validatorWrapped, validatorCases, validatorLargeCases, validatorMalformedCases, validatorRejected, validatorBoundaryCases, validatorAdditionalCases, validatorPathError, validatorStringPathCases, validatorZero, validatorCase,
  validatorMutations, validatorCached, validatorLiteralCached, validatorAdditionalCached, validatorCachedStringPaths, validatorControls, checkValidatorOwnData].map((fn) => fn.toString()).join("\n");
