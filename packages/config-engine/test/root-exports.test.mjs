import * as configEngine from "@weaver-conf/config-engine";

const existingRuntimeExports = [
  "buildPath",
  "clearRegexCache",
  "cloneValue",
  "consoleLogger",
  "createSchemaRegistry",
  "deepEqual",
  "deepGet",
  "deepMerge",
  "deepRemove",
  "deepSet",
  "detectBreakingChanges",
  "diffSchemaKeys",
  "extractErrorMessage",
  "getCachedRegex",
  "getSchemaProperties",
  "getSchemaPropertyType",
  "isNodeError",
  "isSafePattern",
  "matchGlob",
  "readonlyGuard",
  "safeParseConfigEntries",
  "schemasEqual",
];

test("preserves the existing package-root runtime exports", () => {
  for (const exportName of existingRuntimeExports) {
    expect(configEngine[exportName]).toBeDefined();
  }
});

test("derives contracts, namespaces, and qualified keys from the package root", () => {
  const contract = configEngine.deriveContractFromPackageJson({
    name: "@weaver-conf/vessel-view-plugin",
    version: "1.2.3",
  });

  expect(contract).toMatchObject({
    pluginId: "@weaver-conf/vessel-view-plugin",
    namespace: "weaverConf.vesselView",
    version: "1.2.3",
  });
  expect(configEngine.deriveNamespace("ghost.vessel-view")).toBe(
    "ghost.vesselView",
  );
  expect(configEngine.qualifyKey("ghost.vesselView", "map.zoom")).toBe(
    "ghost.vesselView.map.zoom",
  );
  expect(configEngine.validateKeyFormat("ghost.vesselView.map.zoom")).toEqual({
    valid: true,
  });
});

test("resolves and inspects layer values from the package root", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "ghost.shell.theme": "light" } },
      { layer: "user", entries: { "ghost.shell.theme": "dark" } },
    ],
  };

  const resolved = configEngine.resolveConfiguration(stack);
  const inspection = configEngine.inspectKey(stack, "ghost.shell.theme");

  expect(resolved.entries["ghost.shell.theme"]).toBe("dark");
  expect(resolved.provenance.get("ghost.shell.theme")).toBe("user");
  expect(inspection.effectiveValue).toBe("dark");
  expect(inspection.layerValues).toEqual({ core: "light", user: "dark" });
});

test("composes declarations and generates JSON and Zod schemas from the root", () => {
  const composition = configEngine.composeConfigurationSchemas([
    {
      ownerId: "ghost.shell",
      namespace: "ghost.shell",
      properties: {
        theme: { type: "string", default: "dark" },
      },
    },
  ]);

  const jsonSchema = configEngine.generateJsonSchema(composition.schemas);
  const zodSource = configEngine.generateZodSchemaSource(composition.schemas);

  expect(composition.errors).toEqual([]);
  expect(jsonSchema.properties["ghost.shell.theme"]).toMatchObject({
    type: "string",
    default: "dark",
  });
  expect(zodSource).toContain(
    'export const ghost_shell_theme = z.string().default("dark");',
  );
});
