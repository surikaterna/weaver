import { createInMemoryStorageProvider } from "../src/in-memory-provider.ts";

test("constructs with default empty entries", async () => {
  const provider = createInMemoryStorageProvider({
    id: "mem-1",
    layer: "session",
  });
  const data = await provider.load();
  expect(data.entries).toEqual({});
});

test("constructs with initial entries", async () => {
  const provider = createInMemoryStorageProvider({
    id: "mem-2",
    layer: "session",
    initialEntries: { "example.app.theme": "dark" },
  });
  const data = await provider.load();
  expect(data.entries).toEqual({ "example.app.theme": "dark" });
});

test("load returns a snapshot (not a live reference)", async () => {
  const provider = createInMemoryStorageProvider({
    id: "mem-3",
    layer: "session",
    initialEntries: { key: "value" },
  });
  const data1 = await provider.load();
  data1.entries.key = "mutated";
  const data2 = await provider.load();
  expect(data2.entries.key).toBe("value");
});

test("write adds entries", async () => {
  const provider = createInMemoryStorageProvider({
    id: "mem-4",
    layer: "session",
  });
  const result = await provider.write("example.app.zoom", 5);
  expect(result.success).toBe(true);
  const data = await provider.load();
  expect(data.entries.example.app.zoom).toBe(5);
});

test("write overwrites existing entries", async () => {
  const provider = createInMemoryStorageProvider({
    id: "mem-5",
    layer: "session",
    initialEntries: { key: "old" },
  });
  await provider.write("key", "new");
  const data = await provider.load();
  expect(data.entries.key).toBe("new");
});

test("remove deletes entries", async () => {
  const provider = createInMemoryStorageProvider({
    id: "mem-6",
    layer: "session",
    initialEntries: { a: 1, b: 2 },
  });
  const result = await provider.remove("a");
  expect(result.success).toBe(true);
  const data = await provider.load();
  expect(data.entries.a).toBe(undefined);
  expect(data.entries.b).toBe(2);
});

test("remove on non-existent key succeeds", async () => {
  const provider = createInMemoryStorageProvider({
    id: "mem-7",
    layer: "session",
  });
  const result = await provider.remove("missing");
  expect(result.success).toBe(true);
});

test("writable is true", () => {
  const provider = createInMemoryStorageProvider({
    id: "mem-8",
    layer: "session",
  });
  expect(provider.writable).toBe(true);
});

test("id and layer are set correctly", () => {
  const provider = createInMemoryStorageProvider({
    id: "test-id",
    layer: "device",
  });
  expect(provider.id).toBe("test-id");
  expect(provider.layer).toBe("device");
});
