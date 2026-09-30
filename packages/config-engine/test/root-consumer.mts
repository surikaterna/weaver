import {
  deriveContractFromPackageJson, deriveNamespace, qualifyKey, validateKeyFormat,
  resolveConfiguration, inspectKey, composeConfigurationSchemas,
  generateJsonSchema, generateZodSchemaSource,
  resolveConfigurationSnapshot, inspectResolvedPath,
  type ResolutionSnapshotInput, type ConfigurationSnapshot, type ResolvedPathInspection,
  type ContractMetadata, type PackageJsonInput, type ResolvedConfiguration,
  type ConfigurationSchemaDeclaration, type ComposeResult, type JsonSchemaDocument,
} from "@weaver-conf/config-engine";
import type { ConfigurationLayerStack, ConfigurationInspection } from "@weaver-conf/config-types";

const pkg: PackageJsonInput = { name: "@ghost/panel-plugin" };
const contract: ContractMetadata = deriveContractFromPackageJson(pkg);
const namespace: string = deriveNamespace(pkg.name);
const key: string = qualifyKey(namespace, "display.limit");
const valid: boolean = validateKeyFormat(key).valid;
const stack: ConfigurationLayerStack = { layers: [{ layer: "core", entries: { [key]: 25 } }] };
const resolved: ResolvedConfiguration = resolveConfiguration(stack);
const inspected: ConfigurationInspection<number> = inspectKey<number>(stack, key);
const declaration: ConfigurationSchemaDeclaration = {
  ownerId: contract.pluginId, namespace,
  properties: { "display.limit": { type: "integer", minimum: 1, default: 25 } },
};
const composed: ComposeResult = composeConfigurationSchemas([declaration]);
const document: JsonSchemaDocument = generateJsonSchema(composed.schemas, { title: "Panel" });
const source: string = generateZodSchemaSource(composed.schemas);
if (!valid || resolved.entries[key] !== 25 || inspected.effectiveValue !== 25
  || document.properties[key]?.minimum !== 1 || !source.includes("z.number().int()")) {
  throw new Error("Root API fixture failed");
}

const snapshotInput: ResolutionSnapshotInput = {
  configuredRanks: [0, 1], ceilings: [{ path: ["cfg", "a"], maxRank: 0 }],
  layers: [
    { layer: "core", providerId: "p0", rank: 0, entries: { cfg: { a: 1, b: 2 } } },
    { layer: "user", providerId: "p1", rank: 1, entries: { cfg: { a: 3, c: 4 } } },
  ],
};
const snapshot: ConfigurationSnapshot = resolveConfigurationSnapshot(snapshotInput);
const nested: ResolvedPathInspection = inspectResolvedPath(snapshot, ["cfg", "a"]);
if (nested.effectiveValue !== 1 || nested.effectiveLayer !== "core"
  || inspectResolvedPath(snapshot, ["cfg"]).effectiveLayer !== undefined) {
  throw new Error("Canonical snapshot fixture failed");
}
