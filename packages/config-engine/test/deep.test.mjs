import { deepGet, deepSet, deepRemove } from "../dist/index.js";

// deepGet
test("deepGet: simple dot path", () => {
  const obj = { db: { host: "localhost", port: 5432 } };
  expect(deepGet(obj, "db.host")).toBe("localhost");
});

test("deepGet: returns subtree for intermediate path", () => {
  const obj = { db: { host: "localhost", port: 5432 } };
  expect(deepGet(obj, "db")).toEqual({ host: "localhost", port: 5432 });
});

test("deepGet: returns undefined for missing path", () => {
  const obj = { db: { host: "localhost" } };
  expect(deepGet(obj, "db.port")).toBe(undefined);
});

test("deepGet: returns undefined when traversing through primitive", () => {
  const obj = { db: "not-an-object" };
  expect(deepGet(obj, "db.host")).toBe(undefined);
});

test("deepGet: returns undefined for completely missing root", () => {
  const obj = { db: { host: "localhost" } };
  expect(deepGet(obj, "cache.ttl")).toBe(undefined);
});

test("deepGet: single segment", () => {
  const obj = { theme: "dark" };
  expect(deepGet(obj, "theme")).toBe("dark");
});

test("deepGet: deeply nested", () => {
  const obj = { a: { b: { c: { d: 42 } } } };
  expect(deepGet(obj, "a.b.c.d")).toBe(42);
});

test("deepGet: bracket notation (compound segment)", () => {
  const obj = { app: { plugins: { "example.settings.panel": { retentionDays: 30 } } } };
  expect(deepGet(obj, "app.plugins[example.settings.panel].retentionDays")).toBe(30);
});

test("deepGet: bracket notation subtree", () => {
  const obj = { app: { plugins: { "example.settings.panel": { retentionDays: 30, enabled: true } } } };
  expect(deepGet(obj, "app.plugins[example.settings.panel]")).toEqual({ retentionDays: 30, enabled: true });
});

test("deepGet: null along path returns undefined", () => {
  const obj = { db: null };
  expect(deepGet(obj, "db.host")).toBe(undefined);
});

test("deepGet: returns null leaf", () => {
  const obj = { db: { host: null } };
  expect(deepGet(obj, "db.host")).toBe(null);
});

// deepSet
test("deepSet: sets nested value", () => {
  const obj = { db: { host: "old" } };
  deepSet(obj, "db.host", "new");
  expect(obj.db.host).toBe("new");
});

test("deepSet: creates intermediate objects", () => {
  const obj = {};
  deepSet(obj, "db.host", "localhost");
  expect(obj).toEqual({ db: { host: "localhost" } });
});

test("deepSet: overwrites primitive with object along path", () => {
  const obj = { db: "string-value" };
  deepSet(obj, "db.host", "localhost");
  expect(obj).toEqual({ db: { host: "localhost" } });
});

test("deepSet: sets subtree (object value)", () => {
  const obj = {};
  deepSet(obj, "db", { host: "localhost", port: 5432 });
  expect(obj).toEqual({ db: { host: "localhost", port: 5432 } });
});

test("deepSet: deeply nested creation", () => {
  const obj = {};
  deepSet(obj, "a.b.c.d", 42);
  expect(obj).toEqual({ a: { b: { c: { d: 42 } } } });
});

test("deepSet: bracket notation", () => {
  const obj = { app: { plugins: {} } };
  deepSet(obj, "app.plugins[example.settings.panel].retentionDays", 30);
  expect(obj.app.plugins["example.settings.panel"].retentionDays).toBe(30);
});

test("deepSet: preserves siblings", () => {
  const obj = { db: { host: "old", port: 5432 } };
  deepSet(obj, "db.host", "new");
  expect(obj).toEqual({ db: { host: "new", port: 5432 } });
});

test("deepSet: single segment", () => {
  const obj = {};
  deepSet(obj, "theme", "dark");
  expect(obj).toEqual({ theme: "dark" });
});

test("deepSet: overwrites array with object if path continues", () => {
  const obj = { tags: ["a", "b"] };
  deepSet(obj, "tags.first", "x");
  expect(obj).toEqual({ tags: { first: "x" } });
});

// deepRemove
test("deepRemove: removes leaf", () => {
  const obj = { db: { host: "localhost", port: 5432 } };
  const removed = deepRemove(obj, "db.host");
  expect(removed).toBe(true);
  expect(obj).toEqual({ db: { port: 5432 } });
});

test("deepRemove: does not prune empty parent", () => {
  const obj = { db: { host: "localhost" } };
  deepRemove(obj, "db.host");
  expect(obj).toEqual({ db: {} });
});

test("deepRemove: removes subtree", () => {
  const obj = { db: { host: "localhost", port: 5432 }, cache: { ttl: 60 } };
  const removed = deepRemove(obj, "db");
  expect(removed).toBe(true);
  expect(obj).toEqual({ cache: { ttl: 60 } });
});

test("deepRemove: returns false for missing path", () => {
  const obj = { db: { host: "localhost" } };
  expect(deepRemove(obj, "db.port")).toBe(false);
});

test("deepRemove: returns false when parent is primitive", () => {
  const obj = { db: "string" };
  expect(deepRemove(obj, "db.host")).toBe(false);
});

test("deepRemove: single segment", () => {
  const obj = { theme: "dark", lang: "en" };
  const removed = deepRemove(obj, "theme");
  expect(removed).toBe(true);
  expect(obj).toEqual({ lang: "en" });
});

test("deepRemove: bracket notation", () => {
  const obj = { app: { plugins: { "example.settings.panel": { retentionDays: 30 } } } };
  deepRemove(obj, "app.plugins[example.settings.panel].retentionDays");
  expect(obj.app.plugins["example.settings.panel"]).toEqual({});
});

test("deepRemove: returns false for empty parent chain", () => {
  const obj = {};
  expect(deepRemove(obj, "a.b.c")).toBe(false);
});
