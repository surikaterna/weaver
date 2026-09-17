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
    expect(deriveServicePath("lynx")).toEqual({
      serviceId: "lynx",
      servicePath: "/lynx",
    });
  });

  it("resolves service-relative slot paths under the service root", () => {
    expect(deriveCanonicalSlotPath("lynx", "/plugins")).toBe("/lynx/plugins");
  });

  it("derives fragment path from canonical slot path and providerId", () => {
    expect(
      deriveFragmentPath("lynx", "/plugins", "ghost.settings.panel"),
    ).toEqual({
      serviceId: "lynx",
      servicePath: "/lynx",
      canonicalSlotPath: "/lynx/plugins",
      providerId: "ghost.settings.panel",
      fragmentPath: "/lynx/plugins/ghost.settings.panel",
    });
  });

  it("rejects invalid serviceId, providerId, and slot paths", () => {
    expect(() => deriveServicePath("_weaver")).toThrow();
    expect(() => deriveFragmentPath("lynx", "/plugins", "bad/id")).toThrow();
    expect(() => deriveFragmentPath("lynx", "/plugins", " bad")).toThrow();
    expect(() => deriveCanonicalSlotPath("lynx", "plugins")).toThrow();
    expect(() => deriveCanonicalSlotPath("lynx", "/lynx/plugins")).toThrow();
    expect(() => deriveCanonicalSlotPath("lynx", "/_weaver")).toThrow();
  });

  it("protects the Weaver internal registry root", () => {
    expect(WEAVER_INTERNAL_ROOT).toBe("/_weaver");
    expect(isWeaverInternalPath("/_weaver/registry/schemas")).toBe(true);
    expect(() => assertPublicConfigPath("/_weaver")).toThrow();
    expect(() => assertPublicConfigPath("/_weaver/registry")).toThrow();
  });
});
