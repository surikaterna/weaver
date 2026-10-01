// Literal, counted reversals from actual production; these spans are the W1-W9 ledger.
export const safetyLedger = [
  { site: "W9 import", scope: null, before: "", after: `import {
  appendOwn,
  concatOwn,
  filterOwn,
  mapOwn,
  ownEntries,
  ownField,
  ownValue,
  ownValues,
  preflightWitness,
  schemaEntries,
  someOwn,
  tailOwn,
} from "./structural-witness-own-data";
` },
  { site: "W1 type", scope: "allows", before: `  return Array.isArray(schema.type)
    ? schema.type.includes(type)
    : schema.type === type;`, after: `  const declaredType = ownField(schema, "type");
  return Array.isArray(declaredType)
    ? someOwn(declaredType, (member) => member === type)
    : declaredType === type;` },
  { site: "W2 array child", scope: "child", before: `  if (Array.isArray(value)) return value[Number(key)];`, after: `  if (Array.isArray(value)) return ownValue(value, Number(key));` },
  { site: "W2 record child", scope: "child", before: `  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;`, after: `  return isRecord(value) ? ownValue(value, key) : undefined;` },
  { site: "W3 properties", scope: "objectMembers", before: `  if (schema.properties && Object.hasOwn(schema.properties, key)) {
    const declared = schema.properties[key];
    if (declared) members.push(declared);`, after: `  const properties = ownField(schema, "properties");
  if (properties && Object.hasOwn(properties, key)) {
    const declared = ownField(properties, key);
    if (declared) appendOwn(members, declared);` },
  { site: "W3 patterns", scope: "objectMembers", before: `  for (const [pattern, member] of Object.entries(
    schema.patternProperties ?? {},`, after: `  for (const [pattern, member] of schemaEntries(
    ownField(schema, "patternProperties") ?? {},` },
  { site: "W3 pattern append", scope: "objectMembers", before: `    if (matchesPattern(pattern, key)) members.push(member);`, after: `    if (matchesPattern(pattern, key)) appendOwn(members, member);` },
  { site: "W3 additional", scope: "objectMembers", before: `  const additional = schema.additionalProperties;`, after: `  const additional = ownField(schema, "additionalProperties");` },
  { site: "W4 items", scope: "arrayMembers", before: `  const items = schema.items;`, after: `  const items = ownField(schema, "items");` },
  { site: "W4 tuple slot", scope: "arrayMembers", before: `  const member = Array.isArray(items) ? items[index] : items;`, after: `  const member = Array.isArray(items) ? ownField(items, index) : items;` },
  { site: "W5 head", scope: "directSupport", before: `  const key = path[0];`, after: `  const key = ownField(path, 0);` },
  { site: "W5 tail", scope: "directSupport", before: `path.slice(1)`, after: `tailOwn(path)`, count: 2 },
  { site: "W6 members", scope: "traverseMembers", before: `  for (const member of members) {`, after: `  for (const member of ownValues(members)) {` },
  { site: "W7 payload", scope: "payloadSupport", before: `  for (const [key, value] of Object.entries(incoming)) {`, after: `  for (const [key, value] of ownEntries(incoming)) {` },
  { site: "W8 all", scope: "walkSupport", before: `  const all = schema.allOf ? [...new Set(schema.allOf)].map(combine) : [];`, after: `  const allOf = ownField(schema, "allOf");
  const all = allOf ? mapOwn(new Set(ownValues(allOf)), combine) : [];` },
  { site: "W8 branch predicate", scope: "walkSupport", before: "", after: `  const valid = (branch: Schema) => validBranch(branch, candidate);
` },
  { site: "W8 any", scope: "walkSupport", before: `  const any = schema.anyOf
    ?.filter((branch) => validBranch(branch, candidate))
    .map(combine);`, after: `  const anyOf = ownField(schema, "anyOf");
  const any = anyOf && mapOwn(filterOwn(anyOf, valid), combine);` },
  { site: "W8 one", scope: "walkSupport", before: `  const one = schema.oneOf
    ?.filter((branch) => validBranch(branch, candidate))
    .map(combine);`, after: `  const oneOf = ownField(schema, "oneOf");
  const one = oneOf && mapOwn(filterOwn(oneOf, valid), combine);` },
  { site: "W8 witnesses", scope: "walkSupport", before: `  const witnesses = [direct, ...all];`, after: `  const witnesses = concatOwn([direct], all);` },
  { site: "W8 direct some", scope: "walkSupport", before: `witnesses.some((part) => part.declared)`, after: `someOwn(witnesses, (part) => part.declared)` },
  { site: "W8 any some", scope: "walkSupport", before: `(any?.some((part) => part.declared) ?? false)`, after: `(any ? someOwn(any, (part) => part.declared) : false)` },
  { site: "W8 one some", scope: "walkSupport", before: `(one?.some((part) => part.declared) ?? false)`, after: `(one ? someOwn(one, (part) => part.declared) : false)` },
  { site: "W8 any requirement", scope: "walkSupport", before: `(!any || any.some((part) => part.declared))`, after: `(!any || someOwn(any, (part) => part.declared))` },
  { site: "W8 one slot", scope: "walkSupport", before: `one[0]?.declared`, after: `ownField(one, 0)?.declared` },
  { site: "W8 parts", scope: "walkSupport", before: `  const parts = [...witnesses, ...(any ?? []), ...(one ?? [])];`, after: `  const parts = concatOwn(witnesses, any ?? [], one ?? []);` },
  { site: "W8 array aggregate", scope: "walkSupport", before: `parts.some((part) => part.arrayIndex)`, after: `someOwn(parts, (part) => part.arrayIndex)` },
  { site: "W8 ambiguous aggregate", scope: "walkSupport", before: `parts.some((part) => part.ambiguous)`, after: `someOwn(parts, (part) => part.ambiguous)` },
  { site: "W9 preflight", scope: "schemaWriteSupport", before: "", after: `  preflightWitness(schema, path, incoming, fullCandidate, previous);
` },
];

export function reverseSafety(source) {
  let restored = source;
  for (const { site, scope, before, after, count = 1 } of safetyLedger) {
    const anchor = scope === null ? null : `function ${scope}(`;
    if (anchor && restored.split(anchor).length !== 2) throw Error(`${site}: function anchor count`);
    const start = anchor ? restored.indexOf(anchor) : 0;
    const next = anchor ? restored.indexOf("\n}", start) : -1;
    if (anchor && next < start) throw Error(`${site}: missing function end`);
    const end = next < 0 ? restored.length : next + 2;
    const region = restored.slice(start, end);
    if (region.split(after).length - 1 !== count) throw Error(`${site}: safety span count`);
    restored = restored.slice(0, start) + region.split(after).join(before) + restored.slice(end);
  }
  return restored;
}

// Serializable so identical real API adversaries run in isolated Node and packed browser contexts.
export function exerciseOwnData(support, engine) {
  const yes = { declared: true, arrayIndex: false, ambiguous: false };
  const no = { declared: false, arrayIndex: false, ambiguous: false };
  const arrayYes = { ...yes, arrayIndex: true };
  const arrayNo = { ...no, arrayIndex: true };
  const leaf = { type: "boolean" };
  const object = { type: "object", properties: { enabled: leaf } };
  const branch = { ...object, required: ["enabled"] };
  const call = (schema, path = ["enabled"], incoming = true, candidate = { enabled: true }, previous = {}) =>
    support.schemaWriteSupport(schema, path, incoming, candidate, previous);
  function check(actual, expected, label) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`${label}: ${JSON.stringify(actual)}`);
  }
  function trapped(target, key, value, operation, expected, label, counters = [0, 0]) {
    const original = Object.getOwnPropertyDescriptor(target, key);
    let getters = 0;
    let setters = 0;
    let result;
    let error;
    try {
      Object.defineProperty(target, key, { configurable: true,
        get() { getters++; return value; },
        set(data) { setters++; Object.defineProperty(this, key, { value: data, writable: true, enumerable: true, configurable: true }); } });
      try { result = operation(); } catch (caught) { error = caught; }
    } finally {
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    }
    check([getters, setters], counters, `${label} counters`);
    if (error) throw error;
    check(result, expected, label);
  }
  const sparsePayload = new Array(2);
  sparsePayload[1] = true;
  const cases = [
    ["W3 basic scratch", () => call(object), yes],
    ["W4 missing tuple", () => call({ type: "array", items: [leaf] }, ["1"], true, [], []), arrayNo],
    ["W4 tuple hole", () => call({ type: "array", items: new Array(2) }, ["1"], true, [], []), arrayNo],
    ["W4 own undefined tuple", () => call({ type: "array", items: [leaf, undefined] }, ["1"], true, [], []), arrayNo],
    ["W4 own tuple", () => call({ type: "array", items: [leaf, leaf] }, ["1"], true, [], []), arrayYes],
    ["W1 union W5 tails", () => call({ type: ["object", "array"], properties: { enabled: object } }, ["enabled", "enabled"], true, {}, {}), yes],
    ["W3 patterns", () => call({ type: "object", patternProperties: { "^enabled$": leaf } }), yes],
    ["W3 additional", () => call({ type: "object", additionalProperties: leaf }), yes],
    ["W7 object payload", () => call(object, [], { enabled: true }), yes],
    ["W7 sparse array payload", () => call({ type: "array", items: leaf }, [], sparsePayload, sparsePayload, []), yes],
    ["W8 all dedupe", () => call({ allOf: [object, object] }), yes],
    ["W8 real any", () => call({ anyOf: [branch] }), yes],
    ["W8 real one", () => call({ oneOf: [branch] }), yes],
    ["W8 one ambiguous", () => call({ oneOf: [branch, branch] }), no],
    ["W8 invalid candidate", () => call({ anyOf: [branch] }, ["enabled"], "bad", { enabled: "bad" }), no],
    ["W2 absent candidate/previous slots", () => call({ type: "array", items: { anyOf: [branch] } }, ["1", "enabled"], true, new Array(2), new Array(2)), arrayNo],
    ["W2 absent high candidate/previous slots", () => call({ type: "array", items: { anyOf: [branch] } }, ["700", "enabled"], true, new Array(701), new Array(701)), arrayNo],
    ["real engine branch preparation", () => engine.validateEffectiveConfiguration(branch, { enabled: true }).valid, true],
  ];
  // Inputs with own high slots are constructed before traps; production owns only its scratch.
  const highTuple = new Array(701);
  highTuple[700] = leaf;
  cases.push(["W4 own high sparse tuple", () => call({ type: "array", items: highTuple }, ["700"], true, [], []), arrayYes]);
  const wideProperties = {};
  const wideValue = {};
  for (let index = 0; index < 702; index++) { wideProperties[`k${index}`] = leaf; wideValue[`k${index}`] = true; }
  const wideBranch = { type: "object", properties: wideProperties };
  cases.push(["W7/W8 high scratch real validator", () => call({ anyOf: [wideBranch] }, [], wideValue, wideValue), yes]);
  for (const target of [Object.prototype, Array.prototype]) {
    for (const key of ["0", "1", "700"]) {
      for (const [label, operation, expected] of cases) trapped(target, key, leaf, operation, expected, label);
      trapped(target, key, leaf, () => new Array(Number(key)).push(leaf), Number(key) + 1, "unsafe setter control", [0, 1]);
      trapped(target, key, leaf, () => new Array(Number(key) + 1)[key], leaf, "unsafe getter control", [1, 0]);
    }
  }
  const inheritedFields = [
    ["type", "object", {}, ["enabled"]],
    ["properties", { enabled: leaf }, { type: "object" }, ["enabled"]],
    ["patternProperties", { "^enabled$": leaf }, { type: "object" }, ["enabled"]],
    ["additionalProperties", leaf, { type: "object" }, ["enabled"]],
    ["items", leaf, { type: "array" }, ["1"]],
    ["allOf", [object], {}, ["enabled"]],
    ["anyOf", [branch], {}, ["enabled"]],
    ["oneOf", [branch], {}, ["enabled"]],
  ];
  for (const [key, value, schema, path] of inheritedFields) {
    trapped(Object.prototype, key, value, () => call(schema, path), key === "items" ? arrayNo : no, `inherited ${key}`);
    const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
    let result;
    try {
      Object.defineProperty(Object.prototype, key, { configurable: true, value });
      result = call(schema, path);
    } finally {
      if (original) Object.defineProperty(Object.prototype, key, original);
      else delete Object.prototype[key];
    }
    check(result, key === "items" ? arrayNo : no, `inherited data ${key}`);
  }
  trapped(Object.prototype, "enabled", leaf, () => call({ type: "object", properties: {} }), no, "absent own map member");
  check(call({ type: "object", properties: { enabled: leaf }, additionalProperties: { type: "object" } }), yes, "member precedence");
  check(call({ type: "object", additionalProperties: true }), no, "boolean additional does not declare");
  const nullObject = Object.assign(Object.create(null), object);
  check(call(nullObject), yes, "null prototype schema");
  const shared = { type: "object", properties: { left: object, right: object } };
  check(call(shared, [], { left: { enabled: true }, right: { enabled: true } }), yes, "shared graph");
  const cycle = { allOf: [] }; cycle.allOf.push(cycle);
  check(call(cycle), no, "historical composition cycle");
  const recursive = { type: "object", properties: {} }; recursive.properties.self = recursive;
  check(call(recursive, ["self", "self"]), no, "historical member cycle");
  let getterCalls = 0;
  function accessor(value, key) {
    Object.defineProperty(value, key, { configurable: true, enumerable: true, get() { getterCalls++; return leaf; } });
    return value;
  }
  function rejected(operation, label) {
    let caught;
    try { operation(); } catch (error) { caught = error; }
    if (caught?.code !== "VALIDATION_ERROR") throw Error(`${label}: expected typed VALIDATION_ERROR`);
    check(getterCalls, 0, `${label} getters`);
  }
  const unsafeSchemas = [
    accessor({ type: "object" }, "properties"),
    { type: "object", properties: accessor({}, "enabled") },
    { type: "object", patternProperties: accessor({}, "^enabled$") },
    { type: "array", items: accessor([leaf], "0") },
    { anyOf: [accessor({ type: "object" }, "properties")] },
    { oneOf: [branch], "x-weaver": { nested: accessor({}, "secret") } },
    { anyOf: [branch], default: { nested: accessor({}, "enabled") } },
    { anyOf: [branch], example: { nested: accessor({}, "enabled") } },
    { allOf: accessor([object], "0") },
    { type: accessor(["object"], "0") },
    { type: "object", properties: { enabled: leaf }, additionalProperties: accessor({}, "type") },
  ];
  for (const key of ["type", "properties", "patternProperties", "additionalProperties", "items", "allOf", "anyOf", "oneOf"]) {
    unsafeSchemas.push(accessor({ ...object }, key));
  }
  for (const schema of unsafeSchemas) rejected(() => call(schema), "W9 nested schema accessor");
  for (const position of ["incoming", "candidate", "previous"]) {
    const value = accessor({}, "enabled");
    rejected(() => call({ anyOf: [branch] }, ["enabled"], position === "incoming" ? value : true,
      position === "candidate" ? value : { enabled: true }, position === "previous" ? value : {}), `W9 ${position} accessor`);
    for (const key of ["0", "1", "700"]) {
      const array = accessor(new Array(Number(key) + 1), key);
      rejected(() => call(object, ["enabled"], position === "incoming" ? array : true,
        position === "candidate" ? array : { enabled: true }, position === "previous" ? array : {}), `W9 ${position} numeric accessor`);
    }
  }
  rejected(() => call(object, accessor(["enabled"], "0")), "W5 path accessor");
  rejected(() => call(object, new Array(1)), "W5 sparse path");
  for (const key of ["type", "allOf", "anyOf", "oneOf"]) rejected(() => call({ [key]: new Array(1) }), `sparse ${key}`);
  for (const value of [new Date(), new Map(), Object.create({ enabled: true }), Symbol("x"), () => true]) {
    rejected(() => call(object, ["enabled"], value), "W9 exotic incoming");
  }
  const customArray = []; Object.setPrototypeOf(customArray, Object.create(Array.prototype));
  rejected(() => call(object, ["enabled"], customArray), "W9 custom array");
  rejected(() => call(Object.create(object)), "W9 custom schema prototype");
  rejected(() => call({ ...object, [Symbol("metadata")]: true }), "W9 symbol key");
  const metadataArray = []; metadataArray.extra = true;
  rejected(() => call(object, ["enabled"], metadataArray), "W9 unexpected array metadata");
  const hidden = Object.defineProperty({}, "hidden", { get() { getterCalls++; return true; } });
  rejected(() => call({ anyOf: [branch], "x-weaver": hidden }), "W9 hidden accessor");
  rejected(() => call(new Proxy(object, { ownKeys() { throw Error("reflection"); } })), "W9 throwing reflection");
  return { cases: cases.length * 6, inheritedFields: inheritedFields.length, getterCalls };
}

export function exercisePathBoundary(support) {
  const leaf = { type: "boolean" };
  const schema = { type: "object", properties: { enabled: leaf } };
  const nested = { type: "object", properties: { enabled: schema } };
  const expectedMessage = "Invalid structural witness data";
  let getters = 0;
  let callbacks = 0;
  let rejectedCases = 0;
  function rejected(path, label) {
    let failure;
    try { support.schemaWriteSupport(nested, path, true, { enabled: { enabled: true } }, {}); }
    catch (error) { failure = error; }
    if (failure?.code !== "VALIDATION_ERROR" || failure.message !== expectedMessage) throw Error(`${label}: expected typed payload-free failure`);
    if (getters !== 0 || callbacks !== 0) throw Error(`${label}: coercion executed`);
    rejectedCases++;
  }
  const slots = [{}, [], 1, true, null, undefined, Symbol("private marker"), () => "private marker"];
  const paths = [];
  for (const slot of slots) {
    paths.push([slot], ["enabled", slot], ["enabled", "enabled", slot]);
  }
  const hole = new Array(2); hole[0] = "enabled";
  paths.push(hole);
  const accessorPath = ["enabled"];
  Object.defineProperty(accessorPath, "0", { get() { getters++; return "enabled"; } });
  paths.push(accessorPath);
  for (const key of [Symbol.toPrimitive, "toString", "valueOf"]) {
    const ownAccessor = {};
    Object.defineProperty(ownAccessor, key, { get() { getters++; return () => { callbacks++; return "enabled"; }; } });
    paths.push([ownAccessor]);
    paths.push([{ [key]() { callbacks++; return "enabled"; } }]);
  }
  for (const target of [Object.prototype, Array.prototype]) {
    for (const key of [Symbol.toPrimitive, "toString", "valueOf"]) {
      const original = Object.getOwnPropertyDescriptor(target, key);
      try {
        Object.defineProperty(target, key, { configurable: true,
          get() { getters++; return () => { callbacks++; return "enabled"; }; } });
        for (let index = 0; index < paths.length; index++) rejected(paths[index], "malformed own path slot");
        let failure;
        try { support.schemaWriteSupport(schema, [{}], true, { enabled: true }, {}); }
        catch (error) { failure = error; }
        if (failure?.code !== "VALIDATION_ERROR" || failure.message !== expectedMessage) throw Error("public coercion reproduction admitted");
        if (getters !== 0 || callbacks !== 0) throw Error("public coercion reproduction executed");
        rejectedCases++;
      } finally {
        if (original) Object.defineProperty(target, key, original);
        else delete target[key];
      }
    }
  }
  const plainSchema = { type: "object", properties: { "雪.é": leaf, "0": leaf, "700": leaf, "01": leaf } };
  const snapshot = Object.getOwnPropertyDescriptors(plainSchema);
  for (const segment of ["雪.é", "0", "700", "01"]) {
    const result = support.schemaWriteSupport(plainSchema, [segment], true, {}, {});
    if (!result.declared || result.arrayIndex || result.ambiguous) throw Error("ordinary string path changed");
  }
  if (Object.keys(snapshot).length !== Object.keys(plainSchema).length || !support.schemaWriteSupport(schema, [], true, true, {}).declared) throw Error("ordinary root changed");
  // A positive trap control prevents a broken probe from certifying zero callbacks.
  const original = Object.getOwnPropertyDescriptor(Object.prototype, Symbol.toPrimitive);
  let controlGetters = 0;
  let controlCallbacks = 0;
  try {
    Object.defineProperty(Object.prototype, Symbol.toPrimitive, { configurable: true,
      get() { controlGetters++; return () => { controlCallbacks++; return "enabled"; }; } });
    if (String({}) !== "enabled") throw Error("coercion control failed");
  } finally {
    if (original) Object.defineProperty(Object.prototype, Symbol.toPrimitive, original);
    else delete Object.prototype[Symbol.toPrimitive];
  }
  if (controlGetters !== 1 || controlCallbacks !== 1) throw Error("coercion control counters");
  return { rejectedCases, coercionGetters: getters, coercionCallbacks: callbacks, positiveControls: 1 };
}

export const pathBoundaryExercise = `console.log('structural witness string-path boundary', (${exercisePathBoundary.toString()})(support));`;
export const ownDataExercise = `console.log('structural witness own-data matrix', (${exerciseOwnData.toString()})(support, engine)); ${pathBoundaryExercise}`;
