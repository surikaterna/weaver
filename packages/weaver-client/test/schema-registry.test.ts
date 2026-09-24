import type { ConfigurationPropertySchema } from "@weaver-conf/config-types";
import { createClientSchemaRegistry } from "../src/schema-registry.js";

describe("ClientSchemaRegistry", () => {
  it("getSchema returns undefined for unknown key", () => {
    const reg = createClientSchemaRegistry();
    expect(reg.getSchema("unknown.key")).toBe(undefined);
  });

  it("getSchema returns schema after load", () => {
    const reg = createClientSchemaRegistry();
    const schema: ConfigurationPropertySchema = { type: "string" };
    reg.load({ "app.name": schema });
    expect(reg.getSchema("app.name")).toEqual(schema);
  });

  it("isSensitive returns true when x-weaver.sensitive is true", () => {
    const reg = createClientSchemaRegistry();
    reg.load({
      "db.password": {
        type: "string",
        "x-weaver": { sensitive: true },
      },
    });
    expect(reg.isSensitive("db.password")).toBe(true);
  });

  it("isSensitive returns false when not set", () => {
    const reg = createClientSchemaRegistry();
    reg.load({ "app.name": { type: "string" } });
    expect(reg.isSensitive("app.name")).toBe(false);
  });

  it("getRestartRequiredKeys returns correct keys", () => {
    const reg = createClientSchemaRegistry();
    reg.load({
      "app.port": {
        type: "integer",
        "x-weaver": { reloadBehavior: "restart-required" },
      },
      "app.name": {
        type: "string",
        "x-weaver": { reloadBehavior: "hot" },
      },
      "app.workers": {
        type: "integer",
        "x-weaver": { reloadBehavior: "restart-required" },
      },
    });
    const keys = reg.getRestartRequiredKeys();
    expect([...keys].sort()).toEqual(["app.port", "app.workers"]);
  });

  it("validate — valid string passes", () => {
    const reg = createClientSchemaRegistry();
    reg.load({ "app.name": { type: "string", minLength: 1 } });
    expect(reg.validate("app.name", "hello")).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("validate — wrong type fails", () => {
    const reg = createClientSchemaRegistry();
    reg.load({ "app.name": { type: "string" } });
    const result = reg.validate("app.name", 42);
    expect(result.valid).toBe(false);
    expect(result.errors && result.errors.length > 0).toBeTruthy();
  });

  it("validate — enum constraint works", () => {
    const reg = createClientSchemaRegistry();
    reg.load({ "app.env": { type: "string", enum: ["dev", "prod"] } });
    expect(reg.validate("app.env", "dev").valid).toBe(true);
    expect(reg.validate("app.env", "staging").valid).toBe(false);
  });

  it("validate — number min/max works", () => {
    const reg = createClientSchemaRegistry();
    reg.load({ "app.port": { type: "integer", minimum: 1, maximum: 65535 } });
    expect(reg.validate("app.port", 8080).valid).toBe(true);
    expect(reg.validate("app.port", 0).valid).toBe(false);
    expect(reg.validate("app.port", 70000).valid).toBe(false);
  });

  it("validate — unknown key returns valid", () => {
    const reg = createClientSchemaRegistry();
    expect(reg.validate("no.schema", "anything")).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("validate — pattern constraint works", () => {
    const reg = createClientSchemaRegistry();
    reg.load({ "app.id": { type: "string", pattern: "^[a-z]+$" } });
    expect(reg.validate("app.id", "hello").valid).toBe(true);
    expect(reg.validate("app.id", "Hello123").valid).toBe(false);
  });

  it("delegates nested object and composition validation to config-engine", () => {
    const reg = createClientSchemaRegistry();
    reg.load({
      "app.settings": {
        type: "object",
        required: ["mode", "servers"],
        additionalProperties: false,
        properties: {
          mode: {
            type: "string",
            enum: ["safe", "fast"],
          },
          servers: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["host"],
              properties: { host: { type: "string", minLength: 1 } },
              additionalProperties: false,
            },
          },
        },
      },
    });

    expect(
      reg.validate("app.settings", {
        mode: "safe",
        servers: [{ host: "db.internal" }],
      }),
    ).toEqual({ valid: true, errors: [] });
    const invalid = reg.validate("app.settings", {
      mode: "unknown",
      servers: [{ host: "", extra: true }],
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some(({ code }) => code === "unknown-property")).toBe(
      true,
    );
    expect(
      invalid.errors.every(({ segments }) => Array.isArray(segments)),
    ).toBe(true);

    reg.load({
      "app.composed": {
        type: "string",
        oneOf: [{ type: "string", const: "safe" }],
      },
    });
    expect(reg.validate("app.composed", "safe").errors[0]?.code).toBe(
      "invalid-schema",
    );
  });
});
