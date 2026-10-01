import { flattenObject } from "./flatten";

describe("flattenObject", () => {
  it("flattens a nested object to dot-delimited keys", () => {
    const result = flattenObject({ db: { host: "localhost", port: 5432 } });
    expect(result).toEqual({ "db.host": "localhost", "db.port": 5432 });
  });

  it("applies prefix when provided", () => {
    const result = flattenObject({ host: "localhost" }, "db");
    expect(result).toEqual({ "db.host": "localhost" });
  });

  it("handles deeply nested objects", () => {
    const result = flattenObject({ a: { b: { c: 1 } } });
    expect(result).toEqual({ "a.b.c": 1 });
  });

  it("preserves arrays as values", () => {
    const result = flattenObject({ tags: ["a", "b"] });
    expect(result).toEqual({ tags: ["a", "b"] });
  });

  it("handles flat objects (no nesting)", () => {
    const result = flattenObject({ key: "value" });
    expect(result).toEqual({ key: "value" });
  });

  it("returns empty object for empty input", () => {
    expect(flattenObject({})).toEqual({});
  });

  it("handles null values", () => {
    expect(flattenObject({ a: null })).toEqual({ a: null });
  });

  it("wraps compound keys (dots in key names) in brackets", () => {
    const result = flattenObject({
      plugins: { "example.settings.panel": { retentionDays: 30 } },
    });
    expect(result).toEqual({
      "plugins[example.settings.panel].retentionDays": 30,
    });
  });

  it("handles mixed nesting depths", () => {
    const result = flattenObject({
      simple: "val",
      nested: { deep: { value: 42 } },
      shallow: { key: true },
    });
    expect(result).toEqual({
      simple: "val",
      "nested.deep.value": 42,
      "shallow.key": true,
    });
  });
});
