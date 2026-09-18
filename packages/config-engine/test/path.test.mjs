import {
  parsePath,
  buildPath,
  isCompoundSegment,
  pathDepth,
} from "../src/path.ts";
import {
  validateKeyFormat,
  extractNamespace,
} from "../src/namespace.ts";

// parsePath tests

test("parsePath: simple dot path", () => {
  expect(parsePath("a.b.c")).toEqual(["a", "b", "c"]);
});

test("parsePath: single bracket", () => {
  expect(parsePath("a.b[c.d].e")).toEqual(["a", "b", "c.d", "e"]);
});

test("parsePath: multiple brackets", () => {
  expect(parsePath("a[b.c][d.e]")).toEqual(["a", "b.c", "d.e"]);
});

test("parsePath: leading bracket", () => {
  expect(parsePath("[a.b].c")).toEqual(["a.b", "c"]);
});

test("parsePath: trailing bracket", () => {
  expect(parsePath("a.b[c.d]")).toEqual(["a", "b", "c.d"]);
});

test("parsePath: full Lynx example", () => {
  expect(parsePath("lynx.plugins[ghost.settings.panel].retentionDays")).toEqual(["lynx", "plugins", "ghost.settings.panel", "retentionDays"]);
});

test("parsePath: no brackets", () => {
  expect(parsePath("simple.key.here")).toEqual(["simple", "key", "here"]);
});

test("parsePath: single segment", () => {
  expect(parsePath("single")).toEqual(["single"]);
});

test("parsePath: error on unmatched [", () => {
  expect(() => parsePath("a[b.c")).toThrow(/Unmatched '\['/);
});

test("parsePath: error on unmatched ]", () => {
  expect(() => parsePath("a]b")).toThrow(/Unmatched '\]'/);
});

test("parsePath: error on empty brackets", () => {
  expect(() => parsePath("a[]")).toThrow(/Empty brackets/);
});

test("parsePath: error on nested brackets", () => {
  expect(() => parsePath("a[[b]]")).toThrow(/Nested brackets/);
});

test("parsePath: error on empty string", () => {
  expect(() => parsePath("")).toThrow(/must not be empty/);
});

test("parsePath: error on leading dot", () => {
  expect(() => parsePath(".a.b")).toThrow(/Empty segment/);
});

test("parsePath: error on trailing dot", () => {
  expect(() => parsePath("a.b.")).toThrow(/Trailing dot/);
});

test("parsePath: error on double dot", () => {
  expect(() => parsePath("a..b")).toThrow(/Empty segment/);
});

test("parsePath: rejects dangerous dot and bracket segments", () => {
  for (const segment of ["__proto__", "constructor", "prototype"]) {
    expect(() => parsePath(`safe.${segment}.value`)).toThrow(`Path segment "${segment}" is not allowed`);
    expect(() => parsePath(`safe[${segment}].value`)).toThrow(`Path segment "${segment}" is not allowed`);
  }
});

// buildPath tests

test("buildPath: simple segments", () => {
  expect(buildPath(["a", "b", "c"])).toBe("a.b.c");
});

test("buildPath: compound segment", () => {
  expect(buildPath(["a", "b", "c.d", "e"])).toBe("a.b[c.d].e");
});

test("buildPath: multiple compounds", () => {
  expect(buildPath(["a", "b.c", "d.e"])).toBe("a[b.c][d.e]");
});

test("buildPath: single compound", () => {
  expect(buildPath(["a.b"])).toBe("[a.b]");
});

test("buildPath: round-trip simple", () => {
  const segments = ["a", "b", "c"];
  expect(parsePath(buildPath(segments))).toEqual(segments);
});

test("buildPath: round-trip compound", () => {
  const segments = ["lynx", "plugins", "ghost.settings.panel", "retentionDays"];
  expect(parsePath(buildPath(segments))).toEqual(segments);
});

test("buildPath: round-trip multiple compounds", () => {
  const segments = ["a", "b.c", "d.e"];
  expect(parsePath(buildPath(segments))).toEqual(segments);
});

test("buildPath: rejects dangerous segments", () => {
  for (const segment of ["__proto__", "constructor", "prototype"]) {
    expect(() => buildPath(["safe", segment])).toThrow(`Path segment "${segment}" is not allowed`);
  }
});

// isCompoundSegment tests

test("isCompoundSegment: compound", () => {
  expect(isCompoundSegment("ghost.settings.panel")).toBe(true);
});

test("isCompoundSegment: simple", () => {
  expect(isCompoundSegment("simple")).toBe(false);
});

// pathDepth tests

test("pathDepth: simple path", () => {
  expect(pathDepth("a.b.c")).toBe(3);
});

test("pathDepth: bracket path", () => {
  expect(pathDepth("a.b[c.d].e")).toBe(4);
});

// validateKeyFormat with brackets

test("validateKeyFormat: bracket key with 4 segments is valid", () => {
  const result = validateKeyFormat("lynx.plugins[ghost.settings.panel].retentionDays");
  expect(result.valid).toBe(true);
});

test("validateKeyFormat: bracket key with 5 segments is valid", () => {
  const result = validateKeyFormat("a.b[c.d.e].f.g");
  expect(result.valid).toBe(true);
});

test("validateKeyFormat: bracket key with 6 segments is valid", () => {
  const result = validateKeyFormat("a.b[c.d.e].f.g.h");
  expect(result.valid).toBe(true);
});

test("validateKeyFormat: bracket key with 2 segments is valid", () => {
  const result = validateKeyFormat("a[b]");
  expect(result.valid).toBe(true);
});

test("validateKeyFormat: invalid chars in compound segment", () => {
  const result = validateKeyFormat("a.b[c.1bad].d");
  expect(result.valid).toBe(false);
});

// extractNamespace with brackets

test("extractNamespace: bracket key returns first two segments", () => {
  expect(extractNamespace("lynx.plugins[ghost.settings.panel].retentionDays")).toBe("lynx.plugins");
});

test("extractNamespace: simple key unchanged behavior", () => {
  expect(extractNamespace("app.vesselView.map.zoom")).toBe("app.vesselView");
});
