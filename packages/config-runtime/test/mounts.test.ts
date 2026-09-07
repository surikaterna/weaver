import {
  buildMountMap,
  resolveMountedNamespace,
  resolveMountedValue,
} from "../src/mounts";

describe("buildMountMap", () => {
  test("scans entries and finds mounts", () => {
    const entries = {
      database: {
        host: "localhost",
        port: { _weaver: "mount" as const, source: "shared.db.port" },
      },
      cache: { _weaver: "mount" as const, source: "shared.cache" },
    };

    const map = buildMountMap(entries);

    expect(map.get("database.port")).toBe("shared.db.port");
    expect(map.get("cache")).toBe("shared.cache");
    expect(map.size).toBe(2);
  });

  test("ignores non-mount values", () => {
    const entries = {
      plain: "value",
      nested: { deep: 42 },
      array: [1, 2, 3],
    };

    const map = buildMountMap(entries);
    expect(map.size).toBe(0);
  });

  test("handles empty entries", () => {
    const map = buildMountMap({});
    expect(map.size).toBe(0);
  });

  test("scans arrays with canonical unambiguous path identities", () => {
    const entries = {
      "group.one": [{ _weaver: "mount" as const, source: "shared[value.one]" }],
      group: {
        one: [{ _weaver: "mount" as const, source: "shared.value" }],
      },
    };

    const map = buildMountMap(entries);

    expect(map.get("[group.one].0")).toBe("shared[value.one]");
    expect(map.get("group.one.0")).toBe("shared.value");
  });
});

describe("resolveMountedValue", () => {
  test("follows single mount", () => {
    const mountMap = new Map([["app.db", "shared.database"]]);
    const getValue = (key: string) =>
      key === "shared.database" ? "postgres://host" : undefined;

    const result = resolveMountedValue("app.db", mountMap, getValue);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolution.value).toBe("postgres://host");
      expect(result.resolution.chain).toEqual(["app.db", "shared.database"]);
    }
  });

  test("follows chain A→B→C", () => {
    const mountMap = new Map([
      ["a", "b"],
      ["b", "c"],
    ]);
    const getValue = (key: string) => (key === "c" ? "final" : undefined);

    const result = resolveMountedValue("a", mountMap, getValue);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolution.value).toBe("final");
      expect(result.resolution.chain).toEqual(["a", "b", "c"]);
    }
  });

  test("detects cycle", () => {
    const mountMap = new Map([
      ["a", "b"],
      ["b", "a"],
    ]);
    const getValue = () => undefined;

    const result = resolveMountedValue("a", mountMap, getValue);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("cycle");
      expect(result.error.chain).toEqual(["a", "b", "a"]);
    }
  });

  test("detects max-depth exceeded", () => {
    const mountMap = new Map([
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "e"],
    ]);
    const getValue = () => "value";

    const result = resolveMountedValue("a", mountMap, getValue, 2);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("max-depth");
    }
  });

  test("resolves immediately for non-mount key", () => {
    const mountMap = new Map<string, string>();
    const getValue = (key: string) =>
      key === "direct" ? "direct-value" : undefined;

    const result = resolveMountedValue("direct", mountMap, getValue);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolution.value).toBe("direct-value");
      expect(result.resolution.chain).toEqual(["direct"]);
    }
  });
});

describe("resolveMountedNamespace", () => {
  test("resolves mounts within prefix", () => {
    const mountMap = new Map([["ns.mounted", "shared.value"]]);
    const getNamespace = (prefix: string) => {
      if (prefix === "ns") {
        return {
          plain: "hello",
          mounted: { _weaver: "mount" as const, source: "shared.value" },
        };
      }
      return {};
    };
    const getValue = (key: string) =>
      key === "shared.value" ? "resolved!" : undefined;

    const result = resolveMountedNamespace(
      "ns",
      mountMap,
      getNamespace,
      getValue,
    );

    expect(result.plain).toBe("hello");
    expect(result.mounted).toBe("resolved!");
  });

  test("returns undefined for unresolvable mounts", () => {
    const mountMap = new Map([
      ["ns.bad", "x"],
      ["x", "ns.bad"],
    ]);
    const getNamespace = () => ({
      bad: { _weaver: "mount" as const, source: "x" },
    });
    const getValue = () => undefined;

    const result = resolveMountedNamespace(
      "ns",
      mountMap,
      getNamespace,
      getValue,
    );

    expect(result.bad).toBe(undefined);
  });
});
