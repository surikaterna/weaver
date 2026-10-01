// Ordinary public API fixtures shared by built roots and real installed consumers.
export function exerciseValidation(engine) {
  const check = (value, message) => { if (!value) throw Error(message); };
  const run = (schema, value, mode) => mode === "effective"
    ? engine.validateEffectiveConfiguration(schema, value)
    : mode === "partial" ? engine.validatePartialConfiguration(schema, value)
      : engine.validateConfigurationPatch(schema, [], value);
  const literal = { nested: [{ leaf: 1 }] };
  const scenarios = [
    ["composition", { type: "boolean", anyOf: [{ type: "boolean", const: true }, { type: "boolean", const: false }],
      oneOf: [{ type: "boolean", const: true }, { type: "boolean", const: false }], allOf: [{ type: "boolean" }], not: { type: "boolean", const: false } }, true, false],
    ["decimal", { type: "number", minimum: 0, maximum: 1, exclusiveMinimum: -1, exclusiveMaximum: 2, multipleOf: 0.1 }, 0.3, 0.35],
    ["Unicode", { type: "string", minLength: 1, maxLength: 2, pattern: "^a" }, "a😀", "bbb"],
    ["const/enum", { type: "object", properties: { nested: { type: "array", items: { type: "object", additionalProperties: true } } }, const: literal, enum: [literal, { nested: [] }] }, { nested: [{ leaf: 1 }] }, { nested: [{ leaf: 2 }] }],
    ["unique", { type: "array", items: { type: "object", additionalProperties: true }, uniqueItems: true, minItems: 2, maxItems: 3 }, [{ x: 1 }, { x: 2 }], [{ x: 1 }, { x: 1 }]],
    ["patterns/wildcard", { type: "object", properties: { fixed: { type: "string" } }, required: ["fixed"], patternProperties: { "^ok": { type: "boolean" } }, additionalProperties: { type: "number" }, minProperties: 2, maxProperties: 3 }, { fixed: "ok", okFlag: true, extra: 1 }, { fixed: 2, okFlag: 2, extra: "bad" }],
    ["unknown", { type: "object", properties: { flag: { type: "boolean" } }, additionalProperties: false }, { flag: true }, { unknown: true }],
    ["nested wildcard", { type: "object", additionalProperties: { type: "object", additionalProperties: { type: "string" } } }, { extra: { value: "ok" } }, { extra: { value: 1 } }],
  ];
  let cases = 0;
  for (const [name, schema, good, bad] of scenarios) {
    for (const mode of ["effective", "partial", "patch"]) {
      check(run(schema, good, mode).valid, `${name}/${mode} valid`);
      check(!run(schema, bad, mode).valid, `${name}/${mode} invalid`);
      cases += 2;
    }
  }
  const names = Array.from({ length: 702 }, (_, index) => `p${index}`);
  const properties = Object.fromEntries(names.map(key => [key, { type: "number" }]));
  const wide = { type: "object", properties, required: names, additionalProperties: false };
  check(engine.validateEffectiveConfiguration(wide, {}).errors.length === 702, "all required errors");
  check(engine.validatePartialConfiguration(wide, Object.fromEntries(names.map(key => [key, "wrong"]))).errors.length === 702, "all value errors");
  check(engine.validatePartialConfiguration({ type: "object", additionalProperties: false }, Object.fromEntries(names.map(key => [key, 1]))).errors.length === 702, "all unknown errors");
  let deepSchema = { type: "boolean" }, deepValue = true;
  for (let index = 0; index < 702; index++) { deepSchema = { type: "object", properties: { next: deepSchema } }; deepValue = { next: deepValue }; }
  check(engine.validateEffectiveConfiguration(deepSchema, deepValue).valid, "deep value");
  check(engine.validateConfigurationPatch(deepSchema, Array(702).fill("next"), true).valid, "deep array path");
  check(engine.validateConfigurationPatch(deepSchema, Array(702).fill("next").join("."), true).valid, "deep string path");
  const many = { type: "boolean", anyOf: Array.from({ length: 702 }, (_, index) => ({ type: "boolean", const: index === 701 })) };
  check(engine.validateEffectiveConfiguration(many, true).valid, "wide composition");
  let calls = 0;
  const accessor = {}; Object.defineProperty(accessor, "hidden", { get() { calls++; return true; } });
  const cycle = {}; cycle.self = cycle;
  const sparse = [true]; sparse.length = 2;
  for (const value of [accessor, { nested: accessor }, cycle, new Date(), { value: Symbol("data") }, Object.create({ flag: true })]) {
    for (const mode of ["effective", "partial", "patch"]) check(run({ type: "object", additionalProperties: true }, value, mode).errors[0].code === "invalid-value", "caller value admission");
  }
  check(engine.validatePartialConfiguration({ type: "array", items: { type: "boolean" } }, sparse).errors[0].code === "invalid-value", "sparse data slots");
  const common = { type: "object", properties: { cfg: { type: "boolean" } } };
  const path = ["cfg"]; Object.defineProperty(path, "0", { get() { calls++; return "cfg"; } });
  const options = {}; Object.defineProperty(options, "path", { get() { calls++; return "cfg"; } });
  for (const bad of [path, Array(1), [{}], [["cfg"]], [undefined]]) check(engine.validateConfigurationPatch(common, bad, true).errors[0].code === "invalid-path", "own path admission");
  check(engine.validatePartialConfiguration(common, {}, options).errors[0].code === "invalid-path", "own options admission");
  check(calls === 0, "caller accessors never execute");
  for (const schema of [{ type: Array(1) }, { type: "array", items: Array(1) }, { type: "boolean", anyOf: Array(1) }, { type: "boolean", enum: Array(1) }, { type: "object", required: Array(1) }, { type: "string", pattern: "(a+)+$" }, { type: "number", multipleOf: 0 }]) check(engine.validatePartialConfiguration(schema, true).errors[0].code === "invalid-schema", "schema semantic errors");
  const cyclicSchema = { type: "boolean" }; cyclicSchema.anyOf = [cyclicSchema];
  check(engine.validateEffectiveConfiguration(cyclicSchema, true).errors[0].code === "invalid-schema", "schema cycles");
  const inherited = Object.create({ type: "boolean" });
  check(engine.validatePartialConfiguration(inherited, true).errors[0].code === "invalid-schema", "inherited type cannot grant");
  const inheritedMap = Object.create({ flag: { type: "boolean" } });
  check(engine.validatePartialConfiguration({ type: "object", properties: inheritedMap }, { flag: true }).errors[0].code === "unknown-property", "inherited member cannot grant");
  check(engine.validateConfigurationPatch({ type: "array", items: [{ type: "boolean" }] }, [1], "untyped").valid, "missing tuple remains undeclared");
  check(engine.validateEffectiveConfiguration({ type: "object", required: ["flag"] }, {}).errors[0].code === "missing-required", "required semantics");
  for (const badPath of ["[", "a".repeat(699) + "["]) {
    const result = engine.validateConfigurationPatch(common, badPath, true, { path: ["base", 2] });
    check(result.errors[0].message === `Invalid path: Unmatched '[' in "${badPath}"`, "terminal bracket diagnostics");
    check(JSON.stringify(result.errors[0].segments) === JSON.stringify(["base", 2]), "diagnostic base path");
  }
  check(JSON.stringify(engine.parsePath("a[0].[literal.dot].😀")) === JSON.stringify(["a", "0", "literal.dot", "😀"]), "literal codec");
  return { ordinaryCases: cases, callerGetterCalls: calls };
}

export function exerciseValidationCache(engine, createSession) {
  const equal = (left, right, label) => { if (JSON.stringify(left) !== JSON.stringify(right)) throw Error(label); };
  const schema = { type: "object", properties: { x: { type: "number", default: 1 }, arr: { type: "array", items: { type: "number" } } }, required: ["x"], additionalProperties: false };
  const options = { path: ["base"] };
  const session = createSession(schema, options);
  const compare = () => {
    equal(session.validateEffective({ arr: [1] }), engine.validateEffectiveConfiguration(schema, { arr: [1] }, options), "effective cache");
    equal(session.validatePartial({ x: 1, arr: [1] }), engine.validatePartialConfiguration(schema, { x: 1, arr: [1] }, options), "partial cache");
    equal(session.validatePatch("x", 1), engine.validateConfigurationPatch(schema, "x", 1, options), "patch cache");
  };
  compare();
  for (const mutate of [
    () => { schema.properties.x.minimum = 2; }, () => { schema.properties.x.default = 2; },
    () => { schema.properties.x.const = 2; }, () => { schema.properties.x.enum = [2]; },
    () => { schema.properties.x.enum[0] = 1; },
    () => { schema.properties.x.anyOf = [{ type: "number", minimum: 0 }, { type: "number", minimum: 10 }]; },
    () => { schema.properties.x.anyOf[0].minimum = 3; },
    () => { schema.properties.arr.items = [{ type: "number" }]; },
    () => { schema.properties.arr.items[0] = { type: "string" }; },
    () => { schema.required[0] = "missing"; },
    () => { Object.defineProperty(schema.properties.x, "minimum", { enumerable: false }); },
    () => { Object.setPrototypeOf(schema.properties.x, null); },
    () => { Object.setPrototypeOf(schema.properties, null); },
    () => { Object.preventExtensions(schema.properties.x); },
  ]) { mutate(); compare(); compare(); }
  const literals = { type: "array", items: { type: "object", additionalProperties: true }, const: [{ x: 1 }], enum: [[{ x: 1 }]], default: [{ x: 1 }] };
  const literalSession = createSession(literals);
  for (const change of [() => {}, () => { literals.const[0].x = 2; }, () => { literals.enum[0][0].x = 2; }, () => { literals.default[0].x = 2; }, () => { Object.freeze(literals.const[0]); }]) {
    change();
    equal(literalSession.validateEffective(undefined), engine.validateEffectiveConfiguration(literals, undefined), "literal default cache");
    equal(literalSession.validatePartial([{ x: 1 }]), engine.validatePartialConfiguration(literals, [{ x: 1 }]), "literal enum cache");
    equal(literalSession.validatePatch([], [{ x: 1 }]), engine.validateConfigurationPatch(literals, [], [{ x: 1 }]), "literal const cache");
  }
  const child = { type: "object", properties: { value: { type: "string" } }, additionalProperties: false };
  const wildcard = { type: "object", additionalProperties: child };
  const wildcardSession = createSession(wildcard);
  for (const change of [() => {}, () => { child.properties.value.type = "number"; }, () => { child.properties.value = { type: "string" }; }, () => { Object.defineProperty(child.properties, "value", { enumerable: false }); }, () => { Object.setPrototypeOf(child, null); }, () => { Object.preventExtensions(child); }, () => { wildcard.additionalProperties = { type: "string" }; }, () => { wildcard.additionalProperties = false; }, () => { wildcard.additionalProperties = true; }]) {
    change();
    equal(wildcardSession.validateEffective({ extra: { value: "ok" } }), engine.validateEffectiveConfiguration(wildcard, { extra: { value: "ok" } }), "wildcard cache");
    equal(wildcardSession.validatePatch(["extra", "value"], "ok"), engine.validateConfigurationPatch(wildcard, ["extra", "value"], "ok"), "wildcard patch cache");
  }
  for (const path of ["[", "a".repeat(699) + "["]) {
    equal(session.validatePatch(path, true), engine.validateConfigurationPatch(schema, path, true, options), "cached malformed path");
    const invalid = createSession(schema, { path });
    equal(invalid.validatePartial({}), engine.validatePartialConfiguration(schema, {}, { path }), "cached malformed options");
  }
}

export const validationFixtureSource = [exerciseValidation, exerciseValidationCache].map(fn => fn.toString()).join("\n");
