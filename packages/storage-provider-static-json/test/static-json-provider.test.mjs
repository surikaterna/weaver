import { createStaticJsonStorageProvider } from "../src/static-json-provider.ts";

test("load returns cloned data", async () => {
  const original = { "example.app.theme": "dark", "example.app.zoom": 5 };
  const provider = createStaticJsonStorageProvider({
    id: "static-1",
    layer: "core",
    data: original,
  });
  const data = await provider.load();
  expect(data.entries).toEqual({ "example.app.theme": "dark", "example.app.zoom": 5 });
});

test("mutation of loaded data does not affect subsequent loads", async () => {
  const original = { "example.app.theme": "dark" };
  const provider = createStaticJsonStorageProvider({
    id: "static-2",
    layer: "core",
    data: original,
  });
  const data1 = await provider.load();
  data1.entries["example.app.theme"] = "changed-by-consumer";
  const data2 = await provider.load();
  expect(data2.entries["example.app.theme"]).not.toBe("changed-by-consumer");
});

test("load returns deep clone (nested objects)", async () => {
  const original = { nested: { a: 1 } };
  const provider = createStaticJsonStorageProvider({
    id: "static-3",
    layer: "app",
    data: original,
  });
  const data1 = await provider.load();
  data1.entries.nested.a = 999;
  const data2 = await provider.load();
  expect(data2.entries.nested.a).toBe(1);
});

test("write returns failure", async () => {
  const provider = createStaticJsonStorageProvider({
    id: "static-4",
    layer: "core",
    data: {},
  });
  const result = await provider.write("example.app.theme", "light");
  expect(result.success).toBe(false);
  expect(result.error.code).toBe("READONLY");
  expect(result.error.message).toBe("StaticJsonStorageProvider is read-only");
});

test("remove returns failure", async () => {
  const provider = createStaticJsonStorageProvider({
    id: "static-5",
    layer: "core",
    data: { key: "value" },
  });
  const result = await provider.remove("key");
  expect(result.success).toBe(false);
  expect(result.error.code).toBe("READONLY");
  expect(result.error.message).toBe("StaticJsonStorageProvider is read-only");
});

test("writable is false", () => {
  const provider = createStaticJsonStorageProvider({
    id: "static-6",
    layer: "core",
    data: {},
  });
  expect(provider.writable).toBe(false);
});

test("id and layer are set correctly", () => {
  const provider = createStaticJsonStorageProvider({
    id: "my-id",
    layer: "module",
    data: {},
  });
  expect(provider.id).toBe("my-id");
  expect(provider.layer).toBe("module");
});
