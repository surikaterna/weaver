export const rootExports = ["canonicalSchemaRegistryOptionsSchema", "createCanonicalSchemaRegistry", "createRegisteredReadProjection",
  "registeredMutationEvidence", "registeredMutationEvidenceSchema", "registeredMutationFootprint", "registeredMutationFootprintSchema",
  "registeredReadProjectionContextSchema", "registeredReadProjectionSchema",
  "registeredReadAccessEvidenceSchema", "registeredReadAccessSchema", "registeredReadViewSourceSchema",
  "registeredSchemaAnchorSchema", "registryProjectionReaderSchema", "schemaRegistrationAuditMetadataSchema", "schemaRegistrationContextSchema",
  "schemaRegistrationRequestSchema", "schemaRegistrationResultSchema", "schemaWriteSupport", "structuralSupportSchema"].sort();
export const internalExports = ["SchemaIdentityPages", "buildIdentityIndex", "cloneState", "createEmptyState",
  "createRegistryAdapter", "schemaKey", "registryStateSchema", "schemaEntrySchema"].sort();

export function exercisePersistenceBoundary(api) {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  let getters = 0;
  const accessor = (object, key, enumerable = true, returned) => Object.defineProperty(object, key, {
    enumerable, get() { getters++; if (returned !== undefined) return returned; throw Error("PRIVATE-GETTER-PAYLOAD"); },
  });
  const reject = (run) => {
    let error;
    try { run(); } catch (caught) { error = caught; }
    check(error?.code === "VALIDATION_ERROR", "expected typed graph rejection");
    check(error.message === "Invalid registry persistence data", "static graph error");
    check(error.cause === undefined && error.details === undefined, "no raw graph error data");
    check(!JSON.stringify(error).includes("PRIVATE"), "graph error disclosure");
    check(getters === 0, "graph boundary executed a getter");
  };
  const { encodeCases, decodeCases } = graphAccessorCases(api, accessor);
  for (const make of encodeCases) reject(() => api.encodeSchemaGraph(make()));
  for (const make of decodeCases) reject(() => api.decodeSchemaGraph(make()));
  const calls = checkGraphFidelity(api, check, reject);
  check(getters === 0, "graph getter count changed");
  return { accessorCases: encodeCases.length + decodeCases.length, getters, calls };
}

function graphAccessorCases(api, accessor) {
  const encodeCases = [
    () => accessor({}, "type", true, "object"),
    () => ({ type: "object", properties: { child: accessor({}, "type") } }),
    () => ({ type: "object", properties: accessor({}, "child") }),
    () => ({ type: "object", allOf: accessor([{}], "0") }),
    () => ({ type: "object", "x-weaver": accessor({}, "sensitive") }),
    () => ({ type: "object", default: { nested: accessor({}, "message") } }),
    () => ({ type: "object", examples: [accessor({}, "hidden", false)] }),
    () => accessor({ type: "object" }, "description", false),
  ];
  const envelope = () => ({ encoding: api.schemaGraphEncoding, version: 1, root: 0, nodes: [{ type: "object" }] });
  const decodeCases = [
    () => accessor(envelope(), "encoding", true, api.schemaGraphEncoding),
    () => accessor(envelope(), "nodes"),
    () => ({ ...envelope(), nodes: accessor([{}], "0") }),
    () => ({ ...envelope(), nodes: [accessor({}, "type")] }),
    () => ({ ...envelope(), nodes: [{ type: "object", properties: accessor({}, "child") }] }),
    () => ({ ...envelope(), nodes: [{ type: "object", "x-weaver": accessor({}, "sensitive") }] }),
    () => ({ ...envelope(), nodes: [{ type: "object", default: { nested: accessor({}, "message") } }] }),
    () => ({ ...envelope(), nodes: [{ type: "object", examples: [accessor({}, "hidden", false)] }] }),
  ];
  return { encodeCases, decodeCases };
}

function checkGraphFidelity(api, check, reject) {
  // Cycles in schema edges are invalid; cyclic unknown-valued annotations are not schema edges.
  const cycle = { type: "object" }; cycle.properties = { self: cycle };
  reject(() => api.encodeSchemaGraph(cycle));
  reject(() => api.decodeSchemaGraph({ encoding: api.schemaGraphEncoding, version: 1, root: 0, nodes: [{ type: "object", not: 0 }] }));
  let calls = 0;
  const literal = Object.create(null);
  Object.defineProperty(literal, "__proto__", { value: { inert: true }, enumerable: true });
  literal.self = literal; literal.regex = /value/giu;
  literal.callable = () => { calls++; return "not called"; };
  const shared = { type: "string", pattern: "^[a-z]+$" };
  const input = { type: "object", default: literal, examples: [literal], properties: { z: shared, a: shared }, additionalProperties: shared };
  Object.defineProperty(input, "description", { value: "hidden-data", enumerable: false });
  const encoded = api.encodeSchemaGraph(input);
  check(Object.keys(encoded.nodes[0]).join(",") === "type,default,description,examples,properties,additionalProperties", "encoded field order changed");
  const decoded = api.decodeSchemaGraph(encoded);
  check(decoded.properties.z === decoded.properties.a && decoded.properties.z === decoded.additionalProperties, "schema DAG sharing lost");
  check(decoded.default === literal && decoded.examples[0] === literal && literal.self === literal, "annotation graph or identity changed");
  check(Object.hasOwn(decoded.default, "__proto__") && decoded.default.__proto__.inert, "inert reserved annotation lost");
  check(decoded.default.regex === literal.regex && decoded.default.callable === literal.callable && calls === 0, "opaque literal changed or invoked");
  check(decoded.description === "hidden-data" && !Object.getOwnPropertyDescriptor(input, "description").enumerable, "nonenumerable data changed");
  const hiddenType = {}; Object.defineProperty(hiddenType, "type", { value: "object" });
  check(api.decodeSchemaGraph(api.encodeSchemaGraph(hiddenType)).type === "object", "own nonenumerable type lost");
  const ordinary = { type: "object", properties: { z: shared, a: shared }, additionalProperties: shared };
  const bytes = JSON.stringify(api.encodeSchemaGraph(ordinary));
  check(JSON.stringify(api.encodeSchemaGraph(api.decodeSchemaGraph(JSON.parse(bytes)))) === bytes, "encoded string roundtrip changed");
  return calls;
}

export const persistenceBoundaryExercise = `(() => {
  ${[graphAccessorCases, checkGraphFidelity, exercisePersistenceBoundary].map(fn => fn.toString()).join("\n")}
  return exercisePersistenceBoundary(persistence);
})()`;

const supportBranches = `
const probe = (schema, path, candidate, previous = {}) => support.schemaWriteSupport(schema, path, true, candidate, previous);
check(probe({ type: 'object', patternProperties: { '^x': { type: 'boolean' } } }, ['xyz'], { xyz: true }).declared, 'pattern');
check(probe({ type: 'object', additionalProperties: { type: 'boolean' } }, ['wild'], { wild: true }).declared, 'schema wildcard');
check(probe({ type: 'object', additionalProperties: true }, ['wild'], { wild: true }).declared, 'explicit unrestricted declaration');
check(!probe({ type: 'object' }, ['wild'], { wild: true }).declared, 'omitted wildcard is not declared');
const openSchema = { type: 'object', additionalProperties: true };
const openValue = { wild: { nested: [null, { enabled: true }] } };
check(support.schemaWriteSupport(openSchema, [], openValue, openValue, {}).declared, 'deep JSON declaration');
const evidence = support.registeredMutationEvidence(openSchema, ['wild', 'nested', '1', 'enabled'], openValue);
check(evidence.declared && evidence.unconstrained && !evidence.forbidden, 'canonical wildcard evidence');
check(support.registeredMutationEvidenceSchema.safeParse(evidence).success, 'native evidence schema');
const footprint = support.registeredMutationFootprint(openSchema, ['wild'], openValue, { wild: null });
check(footprint.some(item => item.path.join('/') === 'wild/nested/1/enabled'), 'removed JSON descendant footprint');
check(support.registeredMutationFootprintSchema.safeParse(footprint).success, 'native footprint schema');
check(probe({ type: 'array', items: { type: 'boolean' } }, ['0'], [true], []).arrayIndex, 'array index');
const union = { type: ['array', 'object'], properties: { '0': { type: 'boolean' } }, items: { type: 'boolean' } };
check(probe(union, ['0'], {}, null).ambiguous, 'numeric ambiguity');
check(!probe(union, ['0'], { '0': true }, {}).arrayIndex, 'object numeric key');
check(probe({ allOf: [schema] }, ['enabled'], { enabled: true }).declared, 'allOf');
for (const keyword of ['anyOf', 'oneOf']) {
  const composed = { [keyword]: [schema, { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }] };
  check(probe(composed, ['enabled'], { enabled: true }).declared, keyword + ' valid branch');
  check(!probe(composed, ['enabled'], { enabled: 'bad' }).declared, keyword + ' invalid candidate');
}
check(!probe({ oneOf: [schema, schema] }, ['enabled'], { enabled: true }).declared, 'oneOf overlap');
const cyclic = { allOf: [] }; cyclic.allOf.push(cyclic);
check(!probe(cyclic, ['enabled'], {}).declared, 'cycle guard');
`;

// This same fixture executes against installed Node exports and complete browser graphs.
export const exercise = `
const internal = typeof api.createRegistryAdapter === 'function';
const adapter = internal ? api.createRegistryAdapter({ defaultEnvironment: 'dev' }) : null;
const registry = internal ? adapter.reader : api.createCanonicalSchemaRegistry({ defaultEnvironment: 'dev' });
const register = request => {
  if (!internal) return registry.register(request);
  const prepared = adapter.prepare(request);
  if (prepared.result.success) prepared.publish();
  return prepared.result;
};
const check = (condition, message) => { if (!condition) throw Error(message); };
const owner = { name: 'host', contact: 'host@example.org' };
check(register({ serviceId: 'svc', environment: 'dev', owner, schema: { type: 'object' },
  fragmentSlots: [{ slotPath: '/plugins', accepts: 'object' }] }).success, 'service');
const schema = { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] };
check(register({ serviceId: 'svc', environment: 'dev', owner, providerId: 'p', slotPath: '/plugins', schema }).success, 'fragment');
check(!register({ serviceId: 'svc', environment: 'dev', owner, providerId: 'bad', slotPath: '/missing', schema }).success, 'invalid slot');
check(!register({ serviceId: 'bad', environment: 'dev', owner, schema: { type: 'object', properties: { bad: { type: 'bogus' } } } }).success, 'invalid schema registration');
check(registry.resolveAnchor('/svc/plugins/p/enabled').kind === 'fragment', 'anchor');
check(registry.getRegisteredSchema('/svc/plugins/p', 'dev') !== null, 'detail');
check(registry.getSchema('svc', 'dev').type === 'object', 'sync schema');
const first = registry.listRegisteredSchemaIdentityPage({ limit: 1 });
check(first.nextCursor.length === 55, 'real crypto cursor');
check(registry.listRegisteredSchemaIdentityPage({ cursor: first.nextCursor }).slots[0].path === '/svc/plugins', 'page');
check(engine.validateEffectiveConfiguration(schema, { enabled: true }).valid, 'effective valid');
check(!engine.validateEffectiveConfiguration(schema, { enabled: 'bad' }).valid, 'effective invalid');
check(!engine.validateEffectiveConfiguration(schema, {}).valid, 'required invalid');
check(engine.validatePartialConfiguration(schema, {}).valid, 'partial missing');
check(!engine.validatePartialConfiguration(schema, { enabled: 'bad' }).valid, 'partial invalid');
check(support.schemaWriteSupport(schema, ['enabled'], true, { enabled: true }, {}).declared, 'declared');
check(!support.schemaWriteSupport(schema, ['unknown'], true, { unknown: true }, {}).declared, 'unknown');
check(support.structuralSupportSchema.safeParse({ declared: true, arrayIndex: false, ambiguous: false }).success, 'support schema');
check(!support.structuralSupportSchema.safeParse({ declared: 'true', arrayIndex: false, ambiguous: false }).success, 'support schema invalid');
${supportBranches}
`;
