import { composeConfigurationSchemas, createSchemaRegistry } from "../src/schema-registry.ts";

test("composes from single declaration", () => {
  const result = composeConfigurationSchemas([
    {
      ownerId: "example.vesselView",
      namespace: "example.vesselView",
      properties: {
        theme: { type: "string", default: "dark" },
      },
    },
  ]);
  expect(result.errors.length).toBe(0);
  expect(result.schemas.size).toBe(1);
  expect(result.schemas.has("example.vesselView.theme")).toBeTruthy();
  const entry = result.schemas.get("example.vesselView.theme");
  expect(entry.ownerId).toBe("example.vesselView");
  expect(entry.fullyQualifiedKey).toBe("example.vesselView.theme");
  expect(entry.schema.type).toBe("string");
});

test("composes from multiple declarations", () => {
  const result = composeConfigurationSchemas([
    {
      ownerId: "example.vesselView",
      namespace: "example.vesselView",
      properties: {
        theme: { type: "string" },
      },
    },
    {
      ownerId: "example.fleetMap",
      namespace: "example.fleetMap",
      properties: {
        zoom: { type: "number", default: 5 },
      },
    },
  ]);
  expect(result.errors.length).toBe(0);
  expect(result.schemas.size).toBe(2);
  expect(result.schemas.has("example.vesselView.theme")).toBeTruthy();
  expect(result.schemas.has("example.fleetMap.zoom")).toBeTruthy();
});

test("detects duplicate keys across declarations", () => {
  const result = composeConfigurationSchemas([
    {
      ownerId: "plugin-a",
      namespace: "example.vesselView",
      properties: {
        theme: { type: "string" },
      },
    },
    {
      ownerId: "plugin-b",
      namespace: "example.vesselView",
      properties: {
        theme: { type: "number" },
      },
    },
  ]);
  const duplicateErrors = result.errors.filter((e) => e.type === "duplicate-key");
  expect(duplicateErrors.length).toBe(1);
  expect(duplicateErrors[0].ownerIds).toBeTruthy();
  expect(duplicateErrors[0].ownerIds).toEqual(["plugin-a", "plugin-b"]);
});

test("validates key format and reports errors", () => {
  const result = composeConfigurationSchemas([
    {
      ownerId: "bad-plugin",
      namespace: "example.bad",
      // relativeKey "1invalid" → qualified key "example.bad.1invalid" has invalid segment
      properties: {
        "1invalid": { type: "string" },
      },
    },
  ]);
  const formatErrors = result.errors.filter((e) => e.type === "invalid-key-format");
  expect(formatErrors.length).toBe(1);
  expect(formatErrors[0].message.includes("1invalid")).toBeTruthy();
});

test("qualifies relative keys with namespace", () => {
  const result = composeConfigurationSchemas([
    {
      ownerId: "example.vesselView",
      namespace: "example.vesselView",
      properties: {
        "map.defaultZoom": { type: "number" },
      },
    },
  ]);
  expect(result.errors.length).toBe(0);
  expect(result.schemas.has("example.vesselView.map.defaultZoom")).toBeTruthy();
});

test("handles declarations with no properties", () => {
  const result = composeConfigurationSchemas([
    {
      ownerId: "example.empty",
      namespace: "example.empty",
      properties: {},
    },
  ]);
  expect(result.errors.length).toBe(0);
  expect(result.schemas.size).toBe(0);
});

test("supports incremental register/get/getSchemasByOwner flows", () => {
  const registry = createSchemaRegistry();
  const registerResult = registry.register({
    ownerId: "example.vesselView",
    namespace: "example.vesselView",
    properties: {
      theme: { type: "string", default: "dark" },
      zoom: { type: "number", default: 5 },
    },
  });

  expect(registerResult.errors.length).toBe(0);
  expect(registerResult.registeredKeys).toEqual([
    "example.vesselView.theme",
    "example.vesselView.zoom",
  ]);

  const schema = registry.getSchema("example.vesselView.theme");
  expect(schema).toBeTruthy();
  expect(schema.ownerId).toBe("example.vesselView");
  expect(schema.schema.type).toBe("string");

  expect(registry.getSchemas().size).toBe(2);
  expect([...registry.getSchemasByOwner("example.vesselView").keys()]).toEqual(["example.vesselView.theme", "example.vesselView.zoom"]);
});

test("preserves first owner deterministically for duplicate keys", () => {
  const registry = createSchemaRegistry();

  const first = registry.register({
    ownerId: "plugin-a",
    namespace: "example.vesselView",
    properties: {
      theme: { type: "string" },
    },
  });
  expect(first.errors.length).toBe(0);

  const second = registry.register({
    ownerId: "plugin-b",
    namespace: "example.vesselView",
    properties: {
      theme: { type: "number" },
    },
  });
  expect(second.errors.length).toBe(1);
  expect(second.errors[0].type).toBe("duplicate-key");
  expect(second.errors[0].ownerIds).toEqual(["plugin-a", "plugin-b"]);

  const composed = registry.getSchema("example.vesselView.theme");
  expect(composed.ownerId).toBe("plugin-a");
  expect(composed.schema.type).toBe("string");
});

test("rebinds key ownership when first owner unregisters", () => {
  const registry = createSchemaRegistry();

  registry.register({
    ownerId: "plugin-a",
    namespace: "example.vesselView",
    properties: {
      theme: { type: "string" },
    },
  });
  registry.register({
    ownerId: "plugin-b",
    namespace: "example.vesselView",
    properties: {
      theme: { type: "number" },
    },
  });

  const unregisterResult = registry.unregister("plugin-a");
  expect(unregisterResult.removedKeys).toEqual([]);

  const composed = registry.getSchema("example.vesselView.theme");
  expect(composed).toBeTruthy();
  expect(composed.ownerId).toBe("plugin-b");
  expect(composed.schema.type).toBe("number");
  expect(registry.getCompositionErrors().length).toBe(0);
});

test("unregister removes all keys using owner index", () => {
  const registry = createSchemaRegistry();

  registry.register({
    ownerId: "plugin-a",
    namespace: "example.multi",
    properties: {
      alpha: { type: "string" },
      beta: { type: "boolean" },
    },
  });

  const unregisterResult = registry.unregister("plugin-a");
  expect(unregisterResult.removedKeys).toEqual([
    "example.multi.alpha",
    "example.multi.beta",
  ]);
  expect(registry.getSchemas().size).toBe(0);
  expect(registry.getSchemasByOwner("plugin-a").size).toBe(0);
});
