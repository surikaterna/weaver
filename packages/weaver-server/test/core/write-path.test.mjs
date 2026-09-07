import { createWeaverConfigService } from "../../src/core/config-service.ts";

function createTestProvider(id, layer, entries, writable = true) {
  let data = { ...entries };
  return {
    id,
    layer,
    writable,
    async load() { return { entries: { ...data } }; },
    async write(key, value) {
      if (!writable) return { success: false, error: { code: "READONLY", message: "read-only" } };
      data[key] = value;
      return { success: true };
    },
    async remove(key) {
      if (!writable) return { success: false, error: { code: "READONLY", message: "read-only" } };
      delete data[key];
      return { success: true };
    },
  };
}

describe("WeaverConfigService write path", () => {
  test("set writes value and updates merged state", async () => {
    const provider = createTestProvider("p1", "platform", { "key": "old" });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const result = await svc.set("platform", "key", "new");
    expect(result.success).toBe(true);
    expect(await svc.get("key")).toBe("new");
  });

  test("remove removes key and updates merged state", async () => {
    const provider = createTestProvider("p1", "platform", { "key": "val" });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const result = await svc.remove("platform", "key");
    expect(result.success).toBe(true);
    expect(await svc.get("key")).toBe(undefined);
  });

  test("set on read-only provider returns error", async () => {
    const provider = createTestProvider("p1", "platform", {}, false);
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const result = await svc.set("platform", "key", "val");
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

    await svc.set("platform", "foo", "bar");
    expect(deltas.length).toBe(1);
    expect(deltas[0].action).toBe("set");
    expect(deltas[0].key).toBe("foo");
    expect(deltas[0].value).toBe("bar");
    expect(deltas[0].layer).toBe("weaver-effective");
  });

  test("delta has correct action for remove", async () => {
    const provider = createTestProvider("p1", "platform", { "x": 1 });
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const deltas = [];
    svc.onDelta((d) => deltas.push(d));

    await svc.remove("platform", "x");
    expect(deltas[0].action).toBe("remove");
    expect(deltas[0].key).toBe("x");
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
    await svc.set("platform", "big", bigValue);

    console.warn = origWarn;
    expect(warnings.some((w) => w.includes("exceeds 1MB"))).toBeTruthy();
  });
});
