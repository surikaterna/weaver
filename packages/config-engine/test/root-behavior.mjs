export const additions = [
  "deriveContractFromPackageJson", "deriveNamespace", "qualifyKey", "validateKeyFormat",
  "resolveConfiguration", "inspectKey", "composeConfigurationSchemas",
  "generateJsonSchema", "generateZodSchemaSource",
];

export function checkRoot(engine, assert) {
  const namespace = engine.deriveNamespace("@example/panel-plugin");
  assert.equal(namespace, "example.panel");
  const contract = engine.deriveContractFromPackageJson({ name: "@example/panel-plugin" });
  assert.deepEqual(contract, { pluginId: "@example/panel-plugin", namespace,
    version: "0.0.0", description: "" });
  assert.equal(engine.deriveContractFromPackageJson({ name: "panel",
    weaver: { configNamespace: "app.panel" } }).namespace, "app.panel");
  const key = engine.qualifyKey(namespace, "display.limit");
  assert.deepEqual(engine.validateKeyFormat(key), { valid: true });
  assert.equal(engine.validateKeyFormat("example..limit").valid, false);
  const stack = { layers: [
    { layer: "core", entries: { [key]: 25, nested: { keep: true, value: 1 } } },
    { layer: "tenant", entries: { [key]: 50, nested: { value: 2 } } },
  ] };
  const resolved = engine.resolveConfiguration(stack);
  assert.deepEqual(resolved.entries.nested, { keep: true, value: 2 });
  assert.equal(resolved.provenance.get("nested"), "tenant");
  assert.equal(resolved.provenance.has("nested.keep"), false);
  assert.deepEqual(engine.inspectKey(stack, key), { key, effectiveValue: 50,
    effectiveLayer: "tenant", layerValues: { core: 25, tenant: 50 } });
  assert.equal(engine.inspectKey(stack, "nested.keep").effectiveValue, undefined);
  assert.deepEqual(engine.inspectKey(stack, "nested").effectiveValue, { value: 2 });
  const declarations = [{ ownerId: contract.pluginId, namespace,
    properties: { "display.limit": { type: "integer", minimum: 1, default: 25 } } }];
  const composed = engine.composeConfigurationSchemas(declarations);
  assert.deepEqual(composed.errors, []);
  assert.equal(composed.schemas.get(key).ownerId, contract.pluginId);
  assert.equal(engine.composeConfigurationSchemas([...declarations,
    { ...declarations[0], ownerId: "other" }]).errors[0].type, "duplicate-key");
  const document = engine.generateJsonSchema(composed.schemas, { title: "Panel" });
  assert.equal(document.title, "Panel");
  assert.equal(document.properties[key].minimum, 1);
  assert.equal(document.properties[key].default, 25);
  assert.equal(document.properties.example, undefined);
  const source = engine.generateZodSchemaSource(composed.schemas);
  assert.ok(source.includes('export const example_panel_display_limit = z.number().int().min(1).default(25);'));
  assert.ok(source.includes('"example.panel.display.limit": example_panel_display_limit'));
  assert.equal("resolveConfigurationWithCeiling" in engine, false);
  assert.deepEqual(engine.deepMerge({ keep: true }, { extra: 1 }), { keep: true, extra: 1 });
}
