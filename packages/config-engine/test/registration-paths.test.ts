import {
  assertPublicConfigPath,
  canonicalConfigPathFromSegments,
  canonicalConfigPathFromStorageKey,
  canonicalConfigPathSchema,
  deriveCanonicalSlotPath,
  deriveFragmentPath,
  deriveServicePath,
  isWeaverInternalPath,
  normalizeConfigPath,
  parseCanonicalConfigPath,
  WEAVER_INTERNAL_ROOT,
} from "../src/registration-paths.js";

describe("schema registration paths", () => {
  it("round trips canonical paths, segments, and storage keys", () => {
    const parsed = parseCanonicalConfigPath(
      "/lynx/plugins/ghost.settings.panel/enabled",
    );
    expect(parsed).toEqual({
      path: "/lynx/plugins/ghost.settings.panel/enabled",
      segments: ["lynx", "plugins", "ghost.settings.panel", "enabled"],
      storageKey: "lynx.plugins[ghost.settings.panel].enabled",
    });
    expect(canonicalConfigPathFromStorageKey(parsed.storageKey)).toEqual(
      parsed,
    );
    expect(canonicalConfigPathFromSegments(parsed.segments)).toEqual(parsed);
    expect(canonicalConfigPathSchema.parse(parsed)).toEqual(parsed);
    expect(canonicalConfigPathFromStorageKey("")).toEqual({
      path: "/",
      segments: [],
      storageKey: "",
    });
  });

  it("rejects malformed canonical path objects at the runtime boundary", () => {
    const valid = parseCanonicalConfigPath("/lynx/plugins");
    for (const malformed of [
      { ...valid, path: "/lynx/wrong" },
      { ...valid, storageKey: "lynx.wrong" },
      {
        path: "/lynx/constructor",
        segments: ["lynx", "constructor"],
        storageKey: "lynx.constructor",
      },
    ]) {
      expect(canonicalConfigPathSchema.safeParse(malformed).success).toBe(
        false,
      );
    }
  });

  it("normalizes trailing slash and rejects non-canonical slash segments", () => {
    expect(parseCanonicalConfigPath("/lynx/plugins/").path).toBe(
      "/lynx/plugins",
    );
    for (const path of [
      "lynx/plugins",
      "/lynx//plugins",
      "/lynx/[plugins]",
      "/lynx/bad]key",
    ]) {
      expect(() => parseCanonicalConfigPath(path)).toThrow();
    }
  });

  it("derives stable service root paths from serviceId", () => {
    expect(deriveServicePath("example-service")).toEqual({
      serviceId: "example-service",
      servicePath: "/example-service",
    });
  });

  it("resolves service-relative slot paths under the service root", () => {
    expect(deriveCanonicalSlotPath("example-service", "/plugins")).toBe(
      "/example-service/plugins",
    );
  });

  it("derives fragment path from canonical slot path and providerId", () => {
    expect(
      deriveFragmentPath("example-service", "/plugins", "ghost.settings.panel"),
    ).toEqual({
      serviceId: "example-service",
      servicePath: "/example-service",
      canonicalSlotPath: "/example-service/plugins",
      providerId: "ghost.settings.panel",
      fragmentPath: "/example-service/plugins/ghost.settings.panel",
    });
  });

  it("rejects invalid serviceId, providerId, and slot paths", () => {
    expect(() => deriveServicePath("_weaver")).toThrow();
    expect(() =>
      deriveFragmentPath("example-service", "/plugins", "bad/id"),
    ).toThrow();
    expect(() =>
      deriveFragmentPath("example-service", "/plugins", " bad"),
    ).toThrow();
    expect(() =>
      deriveCanonicalSlotPath("example-service", "plugins"),
    ).toThrow();
    expect(() =>
      deriveCanonicalSlotPath("example-service", "/example-service/plugins"),
    ).toThrow();
    expect(() =>
      deriveCanonicalSlotPath("example-service", "/_weaver"),
    ).toThrow();
  });

  it("rejects dangerous service, slot, fragment, and canonical path segments", () => {
    Reflect.deleteProperty(Object.prototype, "polluted");
    try {
      for (const segment of ["__proto__", "constructor", "prototype"]) {
        const message = `Path segment "${segment}" is not allowed`;
        expect(() => deriveServicePath(segment)).toThrow(message);
        expect(() => deriveCanonicalSlotPath("lynx", `/${segment}`)).toThrow(
          message,
        );
        expect(() => deriveFragmentPath("lynx", "/plugins", segment)).toThrow(
          message,
        );
        expect(() => normalizeConfigPath(`/lynx/${segment}/polluted`)).toThrow(
          message,
        );
      }
      expect(Reflect.get(Object.prototype, "polluted")).toBe(undefined);
    } finally {
      Reflect.deleteProperty(Object.prototype, "polluted");
    }
  });

  it("protects the Weaver internal registry root", () => {
    expect(WEAVER_INTERNAL_ROOT).toBe("/_weaver");
    expect(isWeaverInternalPath("/_weaver/registry/schemas")).toBe(true);
    expect(() => assertPublicConfigPath("/_weaver")).toThrow();
    expect(() => assertPublicConfigPath("/_weaver/registry")).toThrow();
  });
});
