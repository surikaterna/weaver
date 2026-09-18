import {
  type ContractMetadata,
  composeConfigurationSchemas,
  deriveContractFromPackageJson,
  deriveNamespace,
  generateJsonSchema,
  generateZodSchemaSource,
  inspectKey,
  qualifyKey,
  type ResolvedConfiguration,
  resolveConfiguration,
  validateKeyFormat,
} from "@weaver-conf/config-engine";

const contract: ContractMetadata = deriveContractFromPackageJson({
  name: "ghost.shell",
});
const stack = {
  layers: [{ layer: "core", entries: { "ghost.shell.theme": "dark" } }],
};
const resolved: ResolvedConfiguration = resolveConfiguration(stack);
const inspection = inspectKey<string>(stack, "ghost.shell.theme");
const composition = composeConfigurationSchemas([
  {
    ownerId: "ghost.shell",
    namespace: deriveNamespace(contract.pluginId),
    properties: { theme: { type: "string" } },
  },
]);

export const declarationProof = {
  qualifiedKey: qualifyKey(contract.namespace, "theme"),
  validation: validateKeyFormat("ghost.shell.theme"),
  resolved,
  inspection,
  jsonSchema: generateJsonSchema(composition.schemas),
  zodSource: generateZodSchemaSource(composition.schemas),
};
