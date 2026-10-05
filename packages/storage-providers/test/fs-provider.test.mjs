import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFileSystemStorageProvider } from "../src/fs-provider.ts";

function makeTempDir() {
  const dir = join(tmpdir(), `config-server-test-${randomUUID()}`);
  return dir;
}

test("load() reads valid JSON file", async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "config.json");
  await writeFile(filePath, JSON.stringify({ theme: "dark", fontSize: 14 }));

  try {
    const provider = createFileSystemStorageProvider({
      id: "test",
      layer: "app",
      filePath,
    });
    const data = await provider.load();
    expect(data.entries).toEqual({ theme: "dark", fontSize: 14 });
    expect(typeof data.revision).toBe("string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load() merges environment overlay", async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });
  const basePath = join(dir, "base.json");
  const overlayPath = join(dir, "overlay.json");
  await writeFile(basePath, JSON.stringify({ a: 1, b: { c: 2, d: 3 } }));
  await writeFile(overlayPath, JSON.stringify({ b: { c: 20 }, e: 5 }));

  try {
    const provider = createFileSystemStorageProvider({
      id: "test",
      layer: "app",
      filePath: basePath,
      environmentOverlayPath: overlayPath,
    });
    const data = await provider.load();
    expect(data.entries).toEqual({ a: 1, b: { c: 20, d: 3 }, e: 5 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load() returns empty entries for missing file", async () => {
  const dir = makeTempDir();
  const filePath = join(dir, "nonexistent.json");

  const provider = createFileSystemStorageProvider({
    id: "test",
    layer: "core",
    filePath,
  });
  const data = await provider.load();
  expect(data.entries).toEqual({});
  expect(data.revision).toBe(undefined);
});

test("load() rejects invalid JSON with a sanitized validation error", async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "bad.json");
  await writeFile(filePath, "not valid json {{{");

  try {
    const provider = createFileSystemStorageProvider({
      id: "test",
      layer: "core",
      filePath,
    });
    await expect(provider.load()).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Configuration file contains invalid configuration data",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write() creates file and writes key", async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "config.json");

  try {
    const provider = createFileSystemStorageProvider({
      id: "test",
      layer: "tenant",
      filePath,
      writable: true,
    });
    const result = await provider.write("theme", "light");
    expect(result.success).toBe(true);
    expect(typeof result.revision).toBe("string");

    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    expect(raw).toEqual({ theme: "light" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write() on read-only provider returns failure", async () => {
  const dir = makeTempDir();
  const filePath = join(dir, "config.json");

  const provider = createFileSystemStorageProvider({
    id: "test",
    layer: "core",
    filePath,
    writable: false,
  });
  const result = await provider.write("key", "value");
  expect(result.success).toBe(false);
  expect(result.error.code).toBe("READONLY");
  expect(result.error.message).toBe("Provider is read-only");
});

test("remove() removes key from file", async () => {
  const dir = makeTempDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "config.json");
  await writeFile(filePath, JSON.stringify({ a: 1, b: 2, c: 3 }));

  try {
    const provider = createFileSystemStorageProvider({
      id: "test",
      layer: "tenant",
      filePath,
      writable: true,
    });
    const result = await provider.remove("b");
    expect(result.success).toBe(true);

    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    expect(raw).toEqual({ a: 1, c: 3 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("write() creates parent directory if needed", async () => {
  const dir = makeTempDir();
  const nested = join(dir, "sub", "deep");
  const filePath = join(nested, "config.json");

  try {
    const provider = createFileSystemStorageProvider({
      id: "test",
      layer: "tenant",
      filePath,
      writable: true,
    });
    const result = await provider.write("key", "value");
    expect(result.success).toBe(true);

    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    expect(raw).toEqual({ key: "value" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remove() on read-only provider returns failure", async () => {
  const dir = makeTempDir();
  const filePath = join(dir, "config.json");

  const provider = createFileSystemStorageProvider({
    id: "test",
    layer: "core",
    filePath,
  });
  const result = await provider.remove("key");
  expect(result.success).toBe(false);
  expect(result.error.code).toBe("READONLY");
  expect(result.error.message).toBe("Provider is read-only");
});

test("writable defaults to false", () => {
  const provider = createFileSystemStorageProvider({
    id: "test",
    layer: "core",
    filePath: "/tmp/nonexistent.json",
  });
  expect(provider.writable).toBe(false);
});
