import { deriveContractFromPackageJson } from "../dist/contract-derivation.js";

describe("deriveContractFromPackageJson", () => {
  it("derives correct namespace from scoped package name", () => {
    const result = deriveContractFromPackageJson({
      name: "@weaver-conf/vessel-view-plugin",
      version: "1.0.0",
    });
    expect(result.pluginId).toBe("@weaver-conf/vessel-view-plugin");
    expect(result.namespace).toBe("weaverConf.vesselView");
    expect(result.version).toBe("1.0.0");
  });

  it("derives correct namespace from dotted package name", () => {
    const result = deriveContractFromPackageJson({
      name: "example.vessel-view",
      version: "2.0.0",
    });
    expect(result.namespace).toBe("example.vesselView");
  });

  it("derives correct namespace from unscoped name", () => {
    const result = deriveContractFromPackageJson({
      name: "my-config-tool",
      version: "1.0.0",
    });
    expect(result.namespace).toBe("myConfigTool");
    expect(result.pluginId).toBe("my-config-tool");
  });

  it("uses explicit weaver.configNamespace override", () => {
    const result = deriveContractFromPackageJson({
      name: "@weaver-conf/some-plugin",
      version: "1.0.0",
      weaver: { configNamespace: "custom.namespace" },
    });
    expect(result.namespace).toBe("custom.namespace");
    expect(result.pluginId).toBe("@weaver-conf/some-plugin");
  });

  it("defaults version to '0.0.0' when missing", () => {
    const result = deriveContractFromPackageJson({
      name: "@weaver-conf/test-plugin",
    });
    expect(result.version).toBe("0.0.0");
  });

  it("defaults description to empty string when missing", () => {
    const result = deriveContractFromPackageJson({
      name: "@weaver-conf/test-plugin",
    });
    expect(result.description).toBe("");
  });

  it("returns all fields when all are present", () => {
    const result = deriveContractFromPackageJson({
      name: "@weaver-conf/vessel-view-plugin",
      version: "3.2.1",
      description: "Vessel view configuration plugin",
    });
    expect(result).toStrictEqual({
      pluginId: "@weaver-conf/vessel-view-plugin",
      namespace: "weaverConf.vesselView",
      version: "3.2.1",
      description: "Vessel view configuration plugin",
    });
  });

  it("converts hyphens in package name to camelCase namespace", () => {
    const result = deriveContractFromPackageJson({
      name: "@weaver-conf/theme-default-plugin",
      version: "1.0.0",
    });
    expect(result.namespace).toBe("weaverConf.themeDefault");
  });

  it("preserves pluginId as the raw package name", () => {
    const result = deriveContractFromPackageJson({
      name: "@scope/my-fancy-plugin",
      version: "0.1.0",
    });
    expect(result.pluginId).toBe("@scope/my-fancy-plugin");
    expect(result.namespace).toBe("scope.myFancy");
  });

  it("handles weaver field with no configNamespace", () => {
    const result = deriveContractFromPackageJson({
      name: "@weaver-conf/nav-plugin",
      weaver: {},
    });
    expect(result.namespace).toBe("weaverConf.nav");
    expect(result.version).toBe("0.0.0");
  });
});
