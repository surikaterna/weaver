import {
  assertPublicConfigPath,
  deriveCanonicalSlotPath,
  deriveFragmentPath,
  deriveServicePath,
  isWeaverInternalPath,
  WEAVER_INTERNAL_ROOT,
} from "../src/registration-paths.js";

describe("schema registration paths", () => {
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

  it("protects the Weaver internal registry root", () => {
    expect(WEAVER_INTERNAL_ROOT).toBe("/_weaver");
    expect(isWeaverInternalPath("/_weaver/registry/schemas")).toBe(true);
    expect(() => assertPublicConfigPath("/_weaver")).toThrow();
    expect(() => assertPublicConfigPath("/_weaver/registry")).toThrow();
  });
});
