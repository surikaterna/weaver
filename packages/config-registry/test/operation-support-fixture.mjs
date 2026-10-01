export const rootExports = ["canonicalSchemaRegistryOptionsSchema", "createCanonicalSchemaRegistry", "createRegisteredReadProjection",
  "registeredReadProjectionContextSchema", "registeredReadProjectionSchema",
  "registeredSchemaAnchorSchema", "schemaRegistrationAuditMetadataSchema", "schemaRegistrationContextSchema",
  "schemaRegistrationRequestSchema", "schemaRegistrationResultSchema", "schemaWriteSupport", "structuralSupportSchema"].sort();
export const internalExports = ["SchemaIdentityPages", "buildIdentityIndex", "cloneState", "createEmptyState",
  "createRegistryAdapter", "schemaKey", "registryStateSchema", "schemaEntrySchema"].sort();

const supportBranches = `
const probe = (schema, path, candidate, previous = {}) => support.schemaWriteSupport(schema, path, true, candidate, previous);
check(probe({ type: 'object', patternProperties: { '^x': { type: 'boolean' } } }, ['xyz'], { xyz: true }).declared, 'pattern');
check(probe({ type: 'object', additionalProperties: { type: 'boolean' } }, ['wild'], { wild: true }).declared, 'schema wildcard');
check(!probe({ type: 'object', additionalProperties: true }, ['wild'], { wild: true }).declared, 'unrestricted is not declared');
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
