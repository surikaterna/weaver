import { createTestService } from "../setup-service.ts";
import { deepSet, deepRemove } from "@weaver-conf/config-engine";

const createWeaverConfigService = (options) => createTestService(options, {
  app: { type: "object", properties: { key: { type: "string" }, foo: { type: "string" }, x: { type: "number" }, big: { type: "string" } }, additionalProperties: false },
});

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
  test("set writes value and updates merged state", async () => {
    const provider = createTestProvider("p1", "platform", { app: { key: "old" } });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

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

    await svc.set("platform", "app.foo", "bar");
    expect(deltas.length).toBe(1);
    expect(deltas[0].action).toBe("set");
    expect(deltas[0].key).toBe("app");
    expect(deltas[0].value).toEqual({ foo: "bar" });
    expect(deltas[0].layer).toBe("weaver-effective");
  });

  test("delta has correct action for remove", async () => {
    const provider = createTestProvider("p1", "platform", { app: { x: 1 } });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const deltas = [];
    svc.onDelta((d) => deltas.push(d));

    await svc.remove("platform", "app.x");
    expect(deltas[0].action).toBe("set");
    expect(deltas[0].key).toBe("app");
    expect(deltas[0].value).toEqual({});
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
    await svc.set("platform", "app.big", bigValue);

    console.warn = origWarn;
    expect(warnings.some((w) => w.includes("exceeds 1MB"))).toBeTruthy();
  });
});
