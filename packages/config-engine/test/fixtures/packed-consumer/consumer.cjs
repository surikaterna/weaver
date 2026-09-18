const assert = require("node:assert/strict");
const {
  composeConfigurationSchemas,
  deepMerge,
  deriveContractFromPackageJson,
  deriveNamespace,
  generateJsonSchema,
  generateZodSchemaSource,
  inspectKey,
  qualifyKey,
  resolveConfiguration,
  validateKeyFormat,
} = require("@weaver-conf/config-engine");

const stack = {
  layers: [
    { layer: "core", entries: { "ghost.shell.theme": "light" } },
    { layer: "user", entries: { "ghost.shell.theme": "dark" } },
  ],
};
const composition = composeConfigurationSchemas([
  {
    ownerId: "ghost.shell",
    namespace: "ghost.shell",
    properties: { theme: { type: "string", default: "dark" } },
  },
]);

assert.equal(deriveNamespace("@weaver-conf/shell-plugin"), "weaverConf.shell");
assert.equal(qualifyKey("ghost.shell", "theme"), "ghost.shell.theme");
assert.deepEqual(validateKeyFormat("ghost.shell.theme"), { valid: true });
assert.equal(
  deriveContractFromPackageJson({ name: "ghost.shell" }).namespace,
  "ghost.shell",
);
assert.equal(resolveConfiguration(stack).entries["ghost.shell.theme"], "dark");
assert.equal(inspectKey(stack, "ghost.shell.theme").effectiveLayer, "user");
assert.equal(generateJsonSchema(composition.schemas).type, "object");
assert.match(generateZodSchemaSource(composition.schemas), /z\.string\(\)/);
assert.deepEqual(deepMerge({ nested: { first: 1 } }, { nested: { second: 2 } }), {
  nested: { first: 1, second: 2 },
});
