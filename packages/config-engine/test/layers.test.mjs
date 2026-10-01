import {
  resolveConfiguration,
  inspectKey,
  resolveConfigurationWithCeiling,
} from "../dist/layers.js";

const testLayers = ["core","app","module","integrator","tenant","user","device","session"];
const getRank = (l) => { const i = testLayers.indexOf(l); return i >= 0 ? i : testLayers.length; };

test("resolves with single layer", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.theme": "dark" } },
    ],
  };
  const result = resolveConfiguration(stack);
  expect(result.entries).toEqual({ "example.app.theme": "dark" });
  expect(result.provenance.get("example.app.theme")).toBe("core");
});

test("deep merges multiple layers in priority order", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.theme": "light", "example.app.lang": "en" } },
      { layer: "tenant", entries: { "example.app.theme": "dark" } },
    ],
  };
  const result = resolveConfiguration(stack);
  expect(result.entries["example.app.theme"]).toBe("dark");
  expect(result.entries["example.app.lang"]).toBe("en");
});

test("last layer wins for conflicting keys", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.zoom": 1 } },
      { layer: "app", entries: { "example.app.zoom": 2 } },
      { layer: "user", entries: { "example.app.zoom": 5 } },
    ],
  };
  const result = resolveConfiguration(stack);
  expect(result.entries["example.app.zoom"]).toBe(5);
  expect(result.provenance.get("example.app.zoom")).toBe("user");
});

test("empty layers are skipped", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.theme": "light" } },
      { layer: "app", entries: {} },
      { layer: "tenant", entries: { "example.app.lang": "no" } },
    ],
  };
  const result = resolveConfiguration(stack);
  expect(result.entries).toEqual({
    "example.app.theme": "light",
    "example.app.lang": "no",
  });
});

test("provenance tracks which layer set each key", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.a": 1, "example.app.b": 2 } },
      { layer: "tenant", entries: { "example.app.b": 20 } },
      { layer: "user", entries: { "example.app.c": 3 } },
    ],
  };
  const result = resolveConfiguration(stack);
  expect(result.provenance.get("example.app.a")).toBe("core");
  expect(result.provenance.get("example.app.b")).toBe("tenant");
  expect(result.provenance.get("example.app.c")).toBe("user");
});

test("inspectKey returns per-layer values", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.zoom": 1 } },
      { layer: "tenant", entries: { "example.app.zoom": 3 } },
      { layer: "user", entries: { "example.app.zoom": 5 } },
    ],
  };
  const result = inspectKey(stack, "example.app.zoom");
  expect(result.layerValues.core).toBe(1);
  expect(result.layerValues.tenant).toBe(3);
  expect(result.layerValues.user).toBe(5);
});

test("inspectKey shows correct effectiveValue and effectiveLayer", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.zoom": 1 } },
      { layer: "app", entries: {} },
      { layer: "tenant", entries: { "example.app.zoom": 10 } },
    ],
  };
  const result = inspectKey(stack, "example.app.zoom");
  expect(result.effectiveValue).toBe(10);
  expect(result.effectiveLayer).toBe("tenant");
  expect(result.key).toBe("example.app.zoom");
});

test("inspectKey handles dynamic scope layers", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.zoom": 1 } },
      { layer: "country:NO", entries: { "example.app.zoom": 3 } },
    ],
  };
  const result = inspectKey(stack, "example.app.zoom");
  expect(result.effectiveValue).toBe(3);
  expect(result.effectiveLayer).toBe("country:NO");
  expect(result.layerValues["country:NO"]).toBe(3);
});

test("inspectKey returns undefined for missing key", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.theme": "dark" } },
    ],
  };
  const result = inspectKey(stack, "example.app.nonexistent");
  expect(result.effectiveValue).toBe(undefined);
  expect(result.effectiveLayer).toBe(undefined);
});

test("resolveConfigurationWithCeiling respects maxOverrideLayer", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.zoom": 1 } },
      { layer: "tenant", entries: { "example.app.zoom": 5 } },
      { layer: "user", entries: { "example.app.zoom": 10 } },
    ],
  };
  const schemaMap = new Map([
    ["example.app.zoom", { "x-weaver": { maxOverrideLayer: "tenant" } }],
  ]);
  const result = resolveConfigurationWithCeiling(stack, schemaMap, false, getRank);
  // user layer should be ignored because maxOverrideLayer is tenant
  expect(result.entries["example.app.zoom"]).toBe(5);
});

test("resolveConfigurationWithCeiling emergency override bypasses ceiling", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.zoom": 1 } },
      { layer: "tenant", entries: { "example.app.zoom": 5 } },
      { layer: "user", entries: { "example.app.zoom": 10 } },
    ],
  };
  const schemaMap = new Map([
    ["example.app.zoom", { "x-weaver": { maxOverrideLayer: "tenant" } }],
  ]);
  const result = resolveConfigurationWithCeiling(stack, schemaMap, true, getRank);
  // Emergency override: user layer should NOT be ignored
  expect(result.entries["example.app.zoom"]).toBe(10);
});

test("uses per-layer merge function when provided", () => {
  const shallowReplace = (base, override) => ({ ...base, ...override });
  const stack = {
    layers: [
      { layer: "defaults", entries: { nested: { a: 1, b: 2 } } },
      { layer: "overrides", entries: { nested: { b: 3 } }, merge: shallowReplace },
    ],
  };
  const result = resolveConfiguration(stack);
  // shallowReplace spreads top-level keys, so nested is replaced entirely
  expect(result.entries).toEqual({ nested: { b: 3 } });
});

test("resolveConfigurationWithCeiling allows keys without schema", () => {
  const stack = {
    layers: [
      { layer: "core", entries: { "example.app.zoom": 1 } },
      { layer: "user", entries: { "example.app.zoom": 10 } },
    ],
  };
  const schemaMap = new Map();
  const result = resolveConfigurationWithCeiling(stack, schemaMap, false, getRank);
  expect(result.entries["example.app.zoom"]).toBe(10);
});
