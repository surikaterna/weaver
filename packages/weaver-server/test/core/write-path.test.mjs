import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { registerTestService } from "../fixtures/schema-authority.mjs";
import { deepSet, deepRemove } from "@weaver-conf/config-engine";

function createTestProvider(id, layer, entries, writable = true) {
  let data = { ...entries };
  return {
    id,
    layer,
    writable,
    async load() { return { entries: { ...data } }; },
    async write(key, value) {
      if (!writable) return { success: false, error: { code: "READONLY", message: "read-only" } };
      deepSet(data, key, value);
      return { success: true };
    },
    async remove(key) {
      if (!writable) return { success: false, error: { code: "READONLY", message: "read-only" } };
      deepRemove(data, key);
      return { success: true };
    },
  };
}

describe("WeaverConfigService write path", () => {
  test("legacy unregistered write is rejected without effects", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    await registerTestService(svc, "app", "dev", { key: { type: "string" } });
    const revision = svc.revision;
    let deltas = 0;
    svc.onDelta(() => deltas++);

    const result = await svc.set("platform", "legacy", "permissive");
    expect(result.error?.code).toBe("SCHEMA_NOT_REGISTERED");
    expect((await provider.load()).entries).toEqual({});
    expect(svc.revision).toBe(revision);
    expect(deltas).toBe(0);
    expect(await svc.get("legacy")).toBeUndefined();
  });

  test("declared patterns and schema-valued dynamic members have explicit witnesses", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({ providers: [provider], environment: "dev" });
    const registry = await registerTestService(svc, "app", "dev", {
      name: { type: "string" },
    }, {
      patternProperties: { "^flag_": { type: "boolean" } },
      additionalProperties: { type: "integer" },
    });

    expect((await registry.resolveAnchor("/app", "dev"))?.schema).toMatchObject({
      properties: { name: { type: "string" } },
      patternProperties: { "^flag_": { type: "boolean" } },
      additionalProperties: { type: "integer" },
    });
    expect((await svc.set("platform", "app.name", "ready")).success).toBe(true);
    expect((await svc.set("platform", "app.flag_ready", true)).success).toBe(true);
    expect((await svc.set("platform", "app.retryCount", 3)).success).toBe(true);
    expect(await svc.get("app")).toEqual({ name: "ready", flag_ready: true, retryCount: 3 });
  });

  test("set writes value and updates merged state", async () => {
    const provider = createTestProvider("p1", "platform", { app: { key: "old" } });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    await registerTestService(svc, "app", "dev", { key: { type: "string" } });
    const result = await svc.set("platform", "app.key", "new");
    expect(result.success).toBe(true);
    expect(await svc.get("app.key")).toBe("new");
  });

  test("remove removes key and updates merged state", async () => {
    const provider = createTestProvider("p1", "platform", { app: { key: "val" } });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    await registerTestService(svc, "app", "dev", { key: { type: "string" } });
    const result = await svc.remove("platform", "app.key");
    expect(result.success).toBe(true);
    expect(await svc.get("app.key")).toBe(undefined);
  });

  test("set on read-only provider returns error", async () => {
    const provider = createTestProvider("p1", "platform", {}, false);
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    await registerTestService(svc, "app", "dev", { key: { type: "string" } });
    const result = await svc.set("platform", "app.key", "val");
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("READONLY");
    expect(result.error?.message.includes("read-only")).toBeTruthy();
  });

  test("onDelta fires after successful write", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const deltas = [];
    svc.onDelta((d) => deltas.push(d));

    await registerTestService(svc, "app", "dev", { foo: { type: "string" } });
    await svc.set("platform", "app.foo", "bar");
    expect(deltas.length).toBe(1);
    expect(deltas[0].action).toBe("set");
    expect(deltas[0].key).toBe("app.foo");
    expect(deltas[0].value).toBe("bar");
    expect(deltas[0].layer).toBe("platform");
  });

  test("delta has correct action for remove", async () => {
    const provider = createTestProvider("p1", "platform", { app: { x: 1 } });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const deltas = [];
    svc.onDelta((d) => deltas.push(d));

    await registerTestService(svc, "app", "dev", { x: { type: "number" } });
    await svc.remove("platform", "app.x");
    expect(deltas[0].action).toBe("remove");
    expect(deltas[0].key).toBe("app.x");
    expect(deltas[0].value).toBe(null);
  });

  test("size warning for large values", async () => {
    const provider = createTestProvider("p1", "platform", {});
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);

    const bigValue = "x".repeat(1_048_577);
    await registerTestService(svc, "app", "dev", { big: { type: "string" } });
    await svc.set("platform", "app.big", bigValue);

    console.warn = origWarn;
    expect(warnings.some((w) => w.includes("exceeds 1MB"))).toBeTruthy();
  });
});
