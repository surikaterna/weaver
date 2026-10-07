// The same real witness cases run in built roots and installed Node/browser consumers.
export function exerciseWitness(support, engine) {
  const yes = { declared: true, arrayIndex: false, ambiguous: false };
  const no = { declared: false, arrayIndex: false, ambiguous: false };
  const arrayYes = { ...yes, arrayIndex: true }, arrayNo = { ...no, arrayIndex: true };
  const leaf = { type: "boolean" };
  const object = { type: "object", properties: { enabled: leaf } };
  const branch = { ...object, required: ["enabled"] };
  const call = (schema, path = ["enabled"], incoming = true, candidate = { enabled: true }, previous = {}) => support.schemaWriteSupport(schema, path, incoming, candidate, previous);
  const check = (actual, expected, label) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(label); };
  const sparse = Array(2); sparse[1] = true;
  const high = Array(701); high[700] = leaf;
  const wideProperties = Object.fromEntries(Array.from({ length: 702 }, (_, index) => [`k${index}`, leaf]));
  const wideValue = Object.fromEntries(Object.keys(wideProperties).map(key => [key, true]));
  const cases = [
    ["object", () => call(object), yes],
    ["missing tuple", () => call({ type: "array", items: [leaf] }, ["1"], true, [], []), arrayNo],
    ["tuple hole", () => call({ type: "array", items: Array(2) }, ["1"], true, [], []), arrayNo],
    ["own undefined tuple", () => call({ type: "array", items: [leaf, undefined] }, ["1"], true, [], []), arrayNo],
    ["own tuple", () => call({ type: "array", items: [leaf, leaf] }, ["1"], true, [], []), arrayYes],
    ["union nested path", () => call({ type: ["object", "array"], properties: { enabled: object } }, ["enabled", "enabled"], true, {}, {}), yes],
    ["pattern", () => call({ type: "object", patternProperties: { "^enabled$": leaf } }), yes],
    ["wildcard", () => call({ type: "object", additionalProperties: leaf }), yes],
    ["object payload", () => call(object, [], { enabled: true }), yes],
    ["sparse payload", () => call({ type: "array", items: leaf }, [], sparse, sparse, []), yes],
    ["allOf dedupe", () => call({ allOf: [object, object] }), yes],
    ["anyOf", () => call({ anyOf: [branch] }), yes],
    ["oneOf", () => call({ oneOf: [branch] }), yes],
    ["oneOf ambiguity", () => call({ oneOf: [branch, branch] }), no],
    ["invalid candidate", () => call({ anyOf: [branch] }, ["enabled"], "bad", { enabled: "bad" }), no],
    ["absent value slots", () => call({ type: "array", items: { anyOf: [branch] } }, ["1", "enabled"], true, Array(2), Array(2)), arrayNo],
    ["high absent value slots", () => call({ type: "array", items: { anyOf: [branch] } }, ["700", "enabled"], true, Array(701), Array(701)), arrayNo],
    ["engine branch", () => engine.validateEffectiveConfiguration(branch, { enabled: true }).valid, true],
    ["high own tuple", () => call({ type: "array", items: high }, ["700"], true, [], []), arrayYes],
    ["wide real branch", () => call({ anyOf: [{ type: "object", properties: wideProperties }] }, [], wideValue, wideValue), yes],
  ];
  for (const [label, operation, expected] of cases) check(operation(), expected, label);
  check(call({ type: "object", properties: { enabled: leaf }, additionalProperties: { type: "object" } }), yes, "member precedence");
  check(call({ type: "object", additionalProperties: true }), yes, "explicit boolean wildcard declares JSON");
  check(call({ type: "object" }), no, "omitted wildcard is not a declaration");
  check(call({ type: "object", additionalProperties: false }), no, "false wildcard is not a declaration");
  check(call(Object.assign(Object.create(null), object)), yes, "null prototype");
  check(call({ type: "object", properties: { left: object, right: object } }, [], { left: { enabled: true }, right: { enabled: true } }), yes, "shared DAG");
  const cycle = { allOf: [] }; cycle.allOf.push(cycle);
  check(call(cycle), no, "composition cycle");
  const recursive = { type: "object", properties: {} }; recursive.properties.self = recursive;
  check(call(recursive, ["self", "self"]), no, "member cycle");
  let getters = 0;
  const accessor = (value, key, enumerable = true) => {
    Object.defineProperty(value, key, { enumerable, configurable: true, get() { getters++; return leaf; } });
    return value;
  };
  const reject = (operation, label) => {
    let failure;
    try { operation(); } catch (error) { failure = error; }
    if (failure?.code !== "VALIDATION_ERROR" || failure.message !== "Invalid structural witness data") throw Error(label);
    check(getters, 0, "own getter execution");
  };
  const hazards = [
    accessor({ type: "object" }, "properties"), { type: "object", properties: accessor({}, "enabled") },
    { type: "object", patternProperties: accessor({}, "^enabled$") }, { type: "array", items: accessor([leaf], "0") },
    { anyOf: [accessor({ type: "object" }, "properties")] },
    { oneOf: [branch], "x-weaver": { nested: accessor({}, "secret") } },
    { anyOf: [branch], default: { nested: accessor({}, "enabled") } },
    { anyOf: [branch], example: { nested: accessor({}, "enabled") } },
    { allOf: accessor([object], "0") }, { type: accessor(["object"], "0") },
    { type: "object", additionalProperties: accessor({}, "type") },
  ];
  for (const key of ["type", "properties", "patternProperties", "additionalProperties", "items", "allOf", "anyOf", "oneOf"]) hazards.push(accessor({ ...object }, key));
  for (const schema of hazards) reject(() => call(schema), "schema descriptors");
  for (const position of ["incoming", "candidate", "previous"]) {
    for (const value of [accessor({}, "enabled"), ...[0, 1, 700].map(index => accessor(Array(index + 1), String(index)))]) {
      reject(() => call({ anyOf: [branch] }, ["enabled"], position === "incoming" ? value : true, position === "candidate" ? value : { enabled: true }, position === "previous" ? value : {}), "value descriptors");
    }
  }
  reject(() => call(object, accessor(["enabled"], "0")), "path accessor");
  reject(() => call(object, Array(1)), "path hole");
  for (const key of ["type", "allOf", "anyOf", "oneOf"]) reject(() => call({ [key]: Array(1) }), "sparse metadata");
  for (const value of [new Date(), new Map(), Object.create({ enabled: true }), Symbol("data"), () => true]) reject(() => call(object, ["enabled"], value), "exotic data");
  const inheritedSchema = Object.create(object);
  reject(() => call(inheritedSchema), "inherited schema fields cannot grant");
  const inheritedMap = Object.create({ enabled: leaf });
  reject(() => call({ type: "object", properties: inheritedMap }), "inherited property map cannot grant");
  const inheritedTuple = Object.setPrototypeOf(Array(2), Object.assign(Object.create(Array.prototype), { 1: leaf }));
  reject(() => call({ type: "array", items: inheritedTuple }, ["1"], true, [], []), "inherited tuple cannot grant");
  reject(() => call({ ...object, [Symbol("metadata")]: true }), "symbol key");
  const metadata = []; metadata.extra = true;
  reject(() => call(object, ["enabled"], metadata), "array metadata");
  reject(() => call({ anyOf: [branch], "x-weaver": accessor({}, "hidden", false) }), "hidden getter");
  reject(() => call(new Proxy(object, { ownKeys() { throw Error("reflection"); } })), "throwing reflection");
  return { semanticCases: cases.length, ownGetterCalls: getters };
}

export function exerciseWitnessPaths(support) {
  const leaf = { type: "boolean" };
  const schema = { type: "object", properties: { enabled: { type: "object", properties: { enabled: leaf } } } };
  let getters = 0, callbacks = 0, rejectedCases = 0;
  const paths = [];
  for (const slot of [{}, [], 1, true, null, undefined, Symbol("data"), () => "enabled"]) paths.push([slot], ["enabled", slot], ["enabled", "enabled", slot]);
  const hole = Array(2); hole[0] = "enabled"; paths.push(hole);
  const getter = ["enabled"]; Object.defineProperty(getter, "0", { get() { getters++; return "enabled"; } }); paths.push(getter);
  for (const key of [Symbol.toPrimitive, "toString", "valueOf"]) {
    const slot = {};
    Object.defineProperty(slot, key, { get() { getters++; return () => { callbacks++; return "enabled"; }; } });
    paths.push([slot], [{ [key]() { callbacks++; return "enabled"; } }]);
  }
  for (const path of paths) {
    let failure;
    try { support.schemaWriteSupport(schema, path, true, { enabled: { enabled: true } }, {}); } catch (error) { failure = error; }
    if (failure?.code !== "VALIDATION_ERROR" || failure.message !== "Invalid structural witness data") throw Error("malformed own path admitted");
    rejectedCases++;
  }
  if (getters || callbacks) throw Error("caller coercion executed");
  const ordinary = { type: "object", properties: { "雪.é": leaf, "0": leaf, "700": leaf, "01": leaf } };
  for (const segment of ["雪.é", "0", "700", "01"]) {
    const result = support.schemaWriteSupport(ordinary, [segment], true, {}, {});
    if (!result.declared || result.arrayIndex || result.ambiguous) throw Error("ordinary string path changed");
  }
  if (!support.schemaWriteSupport(ordinary, [], true, true, {}).declared) throw Error("root path changed");
  return { rejectedCases, coercionGetters: getters, coercionCallbacks: callbacks };
}

export const witnessExercise = `console.log('ordinary structural witness', (${exerciseWitness.toString()})(support, engine)); console.log('own path boundary', (${exerciseWitnessPaths.toString()})(support));`;
