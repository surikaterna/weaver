import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { createClientSchemaRegistry } from "../src/schema-registry.js";

const fragmentSchema: ConfigurationPropertySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
      "x-weaver": { sensitive: true, reloadBehavior: "restart-required" },
    },
  },
};

const serviceSchema: ConfigurationPropertySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  "x-weaver": { sensitive: true, reloadBehavior: "hot" },
  properties: {
    name: { type: "string", minLength: 1 },
    nested: {
      type: "object",
      properties: { count: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
    list: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" } },
        additionalProperties: false,
      },
    },
    "feature.flag": { type: "boolean" },
    plugins: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { enabled: { type: "string" } },
      },
    },
    dynamic: {
      type: "object",
      patternProperties: {
        "^fixed$": {
          type: "string",
          "x-weaver": { sensitive: true, reloadBehavior: "rolling-restart" },
        },
      },
      properties: {
        fixed: { type: "string", "x-weaver": { reloadBehavior: "hot" } },
      },
      additionalProperties: {
        type: "number",
        "x-weaver": { reloadBehavior: "restart-required" },
      },
    },
  },
};

function registry(environment = "default") {
  const result = createClientSchemaRegistry(environment);
  result.load({
    "/app:default": serviceSchema,
    "/app/plugins/analytics:default": fragmentSchema,
    "/app:production": {
      type: "object",
      properties: { name: { type: "number" } },
    },
  });
  return result;
}

describe("ClientSchemaRegistry", () => {
  it("resolves canonical storage keys by longest segment-boundary anchor", () => {
    const reg = registry();
    expect(reg.getSchema("app")).toBe(serviceSchema);
    expect(reg.getSchema("app.name")).toEqual(serviceSchema.properties?.name);
    expect(reg.getSchema("app.plugins.analytics")).toBe(fragmentSchema);
    expect(reg.getSchema("app.plugins.analytics.enabled")).toEqual(
      fragmentSchema.properties?.enabled,
    );
    expect(reg.getSchema("application.name")).toBe(undefined);
    expect(reg.getSchema("/app/name")).toBe(undefined);
  });

  it("validates roots effectively and members as relative patches", () => {
    const reg = registry();
    expect(reg.validate("app", { name: "ok" }).valid).toBe(true);
    expect(reg.validate("app", {}).errors[0]?.code).toBe("missing-required");
    expect(reg.validate("app.nested.count", 2).valid).toBe(true);
    expect(reg.validate("app.nested.count", 0).valid).toBe(false);
    expect(reg.validate("app.list.0.label", "first").valid).toBe(true);
    expect(reg.validate("app[feature.flag]", false).valid).toBe(true);
    expect(reg.validate("app.unknown", true).errors[0]?.code).toBe(
      "unknown-property",
    );
    expect(reg.validate("absent.key", Symbol("opaque")).valid).toBe(true);
  });

  it("selects one exact environment, including environment names with colons", () => {
    expect(registry().validate("app.name", 1).valid).toBe(false);
    expect(registry("production").validate("app.name", 1).valid).toBe(true);
    const colon = createClientSchemaRegistry("prod:blue");
    colon.load({
      "/app:prod": { type: "string" },
      "/app:prod:blue": { type: "number" },
    });
    expect(colon.validate("app", 1).valid).toBe(true);
    expect(colon.validate("app", "wrong").valid).toBe(false);
  });

  it("rejects selected-environment aliases and malformed canonical keys", () => {
    const reg = createClientSchemaRegistry();
    expect(() =>
      reg.load({ "app.port:default": { type: "number" } }),
    ).toThrow();
    expect(() => reg.load({ "/app/:default": { type: "object" } })).toThrow();
    expect(() =>
      reg.load({ "/app//port:default": { type: "number" } }),
    ).toThrow();
    expect(() =>
      reg.load({ "app.port:other": { type: "number" } }),
    ).not.toThrow();
  });

  it("resolves local metadata through object patterns, additional values, and items", () => {
    const reg = registry();
    expect(reg.isSensitive("app")).toBe(true);
    expect(reg.isSensitive("app.name")).toBe(false);
    expect(reg.isSensitive("app.plugins.analytics.enabled")).toBe(true);
    expect(reg.getSchema("app.dynamic.fixed")).toBe(undefined);
    expect(reg.isSensitive("app.dynamic.fixed")).toBe(true);
    expect(reg.getReloadBehavior("app.dynamic.fixed")).toBe("rolling-restart");
    expect(reg.getReloadBehavior("app.dynamic.other")).toBe("restart-required");
    expect(reg.getSchema("app.list.0.label")?.type).toBe("string");
  });

  it("does not resolve inherited property keys", () => {
    const properties = Object.create({ inherited: { type: "string" } });
    const reg = createClientSchemaRegistry();
    reg.load({ "/safe:default": { type: "object", properties } });
    expect(reg.getSchema("safe.inherited")).toBe(undefined);
    expect(reg.isSensitive("safe.inherited")).toBe(false);
  });
});
