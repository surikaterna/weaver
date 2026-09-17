import { deepGet, deepRemove, deepSet } from "../src/deep.js";

describe("deepGet", () => {
  it("retrieves nested values", () => {
    const obj = { a: { b: { c: 42 } } };
    expect(deepGet(obj, "a.b.c")).toBe(42);
  });

  it("returns undefined for missing paths", () => {
    expect(deepGet({}, "a.b.c")).toBe(undefined);
  });

  it("returns undefined when traversing through a primitive", () => {
    expect(deepGet({ a: 5 }, "a.b")).toBe(undefined);
  });

  it("handles top-level keys", () => {
    expect(deepGet({ foo: "bar" }, "foo")).toBe("bar");
  });

  it("returns undefined when traversing through null", () => {
    expect(deepGet({ a: null } as Record<string, unknown>, "a.b")).toBe(
      undefined,
    );
  });
});

describe("deepSet", () => {
  it("sets nested values creating intermediates", () => {
    const obj: Record<string, unknown> = {};
    deepSet(obj, "a.b.c", 42);
    expect(obj).toEqual({ a: { b: { c: 42 } } });
  });

  it("overwrites existing values", () => {
    const obj: Record<string, unknown> = { a: { b: 1 } };
    deepSet(obj, "a.b", 2);
    expect((obj.a as Record<string, unknown>).b).toBe(2);
  });

  it("overwrites primitives along the path with objects", () => {
    const obj: Record<string, unknown> = { a: "string" };
    deepSet(obj, "a.b", 10);
    expect(obj).toEqual({ a: { b: 10 } });
  });

  it("sets top-level keys", () => {
    const obj: Record<string, unknown> = {};
    deepSet(obj, "x", 99);
    expect(obj.x).toBe(99);
  });

  it("rejects dangerous dot and bracket segments without changing Object.prototype", () => {
    Reflect.deleteProperty(Object.prototype, "polluted");
    try {
      for (const path of [
        "__proto__.polluted",
        "safe.constructor.polluted",
        "safe[prototype].polluted",
      ]) {
        expect(() => deepSet({}, path, true)).toThrow();
      }
      expect(Reflect.get(Object.prototype, "polluted")).toBe(undefined);
    } finally {
      Reflect.deleteProperty(Object.prototype, "polluted");
    }
  });
});

describe("deepRemove", () => {
  it("removes nested keys and returns true", () => {
    const obj: Record<string, unknown> = { a: { b: 1, c: 2 } };
    const result = deepRemove(obj, "a.b");
    expect(result).toBe(true);
    expect(obj).toEqual({ a: { c: 2 } });
  });

  it("returns false for non-existent paths", () => {
    expect(deepRemove({}, "a.b.c")).toBe(false);
  });

  it("removes top-level keys", () => {
    const obj: Record<string, unknown> = { x: 1, y: 2 };
    expect(deepRemove(obj, "x")).toBe(true);
    expect(obj).toEqual({ y: 2 });
  });

  it("returns false when parent is a primitive", () => {
    const obj: Record<string, unknown> = { a: 5 };
    expect(deepRemove(obj, "a.b")).toBe(false);
  });
});
