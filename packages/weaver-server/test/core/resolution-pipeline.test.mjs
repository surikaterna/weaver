import { createWeaverConfigService } from "../../src/core/config-service.ts";
import { deepSet, deepRemove } from "@weaver-conf/config-engine";

function createTestProvider(id, layer, entries, writable = true) {
  let data = JSON.parse(JSON.stringify(entries));
  return {
    id,
    layer,
    writable,
    async load() { return { entries: JSON.parse(JSON.stringify(data)) }; },
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

describe("Resolution pipeline", () => {
  test("get() resolves ConfigMount transparently", async () => {
    const entries = {
      shared: { dbUrl: "postgres://host/db" },
      myservice: { db: { _weaver: "mount", source: "shared.dbUrl" } },
    };
    const provider = createTestProvider("p1", "platform", entries);
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const value = await svc.get("myservice.db");
    expect(value).toBe("postgres://host/db");
  });

  test("get() resolves SecretReference transparently", async () => {
    const entries = {
      database: { password: { _weaver: "secret-ref", provider: "vault", uri: "db/pass" } },
    };
    const mockBackend = {
      resolve: async (ref) => ref.uri === "db/pass" ? "s3cr3t" : undefined,
    };
    const provider = createTestProvider("p1", "platform", entries);
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
      secretBackend: mockBackend,
    });

    const value = await svc.get("database.password");
    expect(value).toBe("s3cr3t");
  });

  test("get() resolves mount -> secret chain", async () => {
    const entries = {
      shared: { secret: { _weaver: "secret-ref", provider: "vault", uri: "shared/key" } },
      app: { apiKey: { _weaver: "mount", source: "shared.secret" } },
    };
    const mockBackend = {
      resolve: async (ref) => ref.uri === "shared/key" ? "api-key-value" : undefined,
    };
    const provider = createTestProvider("p1", "platform", entries);
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
      secretBackend: mockBackend,
    });

    const value = await svc.get("app.apiKey");
    expect(value).toBe("api-key-value");
  });

  test("getNamespace() resolves markers within namespace", async () => {
    const entries = {
      db: {
        host: "localhost",
        password: { _weaver: "secret-ref", provider: "vault", uri: "db/pass" },
        port: { _weaver: "mount", source: "shared.defaultPort" },
      },
      shared: { defaultPort: 5432 },
    };
    const mockBackend = {
      resolve: async (ref) => ref.uri === "db/pass" ? "secret123" : undefined,
    };
    const provider = createTestProvider("p1", "platform", entries);
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
      secretBackend: mockBackend,
    });

    const ns = await svc.getNamespace("db");
    expect(ns.host).toBe("localhost");
    expect(ns.password).toBe("secret123");
    expect(ns.port).toBe(5432);
  });

  test("resolveAll() returns clean entries (no markers)", async () => {
    const entries = {
      key: { _weaver: "secret-ref", provider: "vault", uri: "x" },
    };
    const mockBackend = {
      resolve: async () => "resolved",
    };
    const provider = createTestProvider("p1", "platform", entries);
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
      secretBackend: mockBackend,
    });

    const snapshot = await svc.resolveAll();
    expect(snapshot.entries.key).toBe("resolved");
  });

  test("without secretBackend, SecretReference markers stay private", async () => {
    const entries = {
      key: { _weaver: "secret-ref", provider: "vault", uri: "x" },
    };
    const provider = createTestProvider("p1", "platform", entries);
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const value = await svc.get("key");
    expect(value).toBe(undefined);
  });

  test("mount cycle returns undefined gracefully", async () => {
    const entries = {
      a: { _weaver: "mount", source: "b" },
      b: { _weaver: "mount", source: "a" },
    };
    const provider = createTestProvider("p1", "platform", entries);
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const value = await svc.get("a");
    expect(value).toBe(undefined);
  });

  test("recursively resolves mounted objects and array markers", async () => {
    const secret = (uri) => ({ _weaver: "secret-ref", provider: "vault", uri });
    const mount = (source) => ({ _weaver: "mount", source });
    const entries = {
      shared: {
        label: "mounted-label",
        bundle: {
          credentials: { password: secret("password") },
          values: [
            secret("first"),
            mount("shared.label"),
            { nested: secret("nested") },
          ],
        },
        cycle: { nested: mount("app.cycle") },
      },
      app: {
        config: mount("shared.bundle"),
        direct: [secret("direct"), mount("shared.label")],
        arrayCycle: [mount("app.arrayCycle[1]"), mount("app.arrayCycle[0]")],
        cycle: mount("shared.cycle"),
      },
    };
    const service = await createWeaverConfigService({
      providers: [createTestProvider("p1", "platform", entries)],
      environment: "dev",
      secretBackend: { resolve: async (ref) => `resolved:${ref.uri}` },
    });
    const expected = {
      credentials: { password: "resolved:password" },
      values: [
        "resolved:first",
        "mounted-label",
        { nested: "resolved:nested" },
      ],
    };

    expect(await service.get("app.config")).toEqual(expected);
    expect(await service.get("app.direct[0]")).toBe("resolved:direct");
    expect(await service.get("app.direct.1")).toBe("mounted-label");
    expect(await service.get("app.arrayCycle[0]")).toBe(undefined);
    expect(await service.getNamespace("app")).toMatchObject({
      config: expected,
      direct: ["resolved:direct", "mounted-label"],
    });
    expect((await service.resolveAll()).entries.app.config).toEqual(expected);
    expect(await service.get("app.cycle")).toEqual({});
    expect(JSON.stringify(await service.resolveAll())).not.toContain("_weaver");
  });

  test("malformed mount candidates fail closed in base and scoped reads", async () => {
    const base = createTestProvider("base", "platform", {
      shared: { value: "resolved" },
      app: {
        missing: { _weaver: "mount" },
        number: { _weaver: "mount", source: 42 },
        null: { _weaver: "mount", source: null },
        empty: { _weaver: "mount", source: "" },
        syntax: { _weaver: "mount", source: "shared[" },
        unsafe: { _weaver: "mount", source: "shared.__proto__" },
        protected: { _weaver: "mount", source: "_weaver.registry" },
        ordinary: { _weaver: "metadata", value: "base-kept" },
        valid: { _weaver: "mount", source: "shared.value" },
      },
      _weaver: { registry: "private" },
    });
    const scoped = createTestProvider("scope", "tenant:acme", {
      app: {
        scopedMissing: { _weaver: "mount" },
        scopedMalformed: { _weaver: "mount", source: ".bad" },
        ordinary: { _weaver: "metadata", value: "scope-kept" },
      },
    });
    const service = await createWeaverConfigService({
      providers: [base, scoped],
      environment: "dev",
    });
    const scopePath = [{ scopeId: "tenant", value: "acme" }];
    const malformedKeys = [
      "missing",
      "number",
      "null",
      "empty",
      "syntax",
      "unsafe",
      "protected",
    ];

    for (const key of malformedKeys) {
      expect(await service.get(`app.${key}`)).toBe(undefined);
    }
    expect(await service.get("app.valid")).toBe("resolved");
    expect(await service.get("app.ordinary")).toEqual({
      _weaver: "metadata",
      value: "base-kept",
    });
    expect(await service.get("app.scopedMissing", { scopePath })).toBe(
      undefined,
    );
    expect(await service.get("app.scopedMalformed", { scopePath })).toBe(
      undefined,
    );

    const namespace = await service.getNamespace("app", { scopePath });
    expect(namespace).toMatchObject({
      ordinary: { _weaver: "metadata", value: "scope-kept" },
      valid: "resolved",
    });
    const snapshot = await service.resolveAll({ scopePath });
    expect(snapshot.scopes["tenant:acme"].app).toEqual(namespace);
    expect(JSON.stringify(snapshot)).not.toContain('"_weaver":"mount"');
  });

  test("mount map rebuilds after set", async () => {
    const entries = {
      shared: { value: "original" },
      app: { ref: { _weaver: "mount", source: "shared.value" } },
    };
    const provider = createTestProvider("p1", "platform", entries);
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    expect(await svc.get("app.ref")).toBe("original");

    await svc.set("platform", "shared.value", "updated");
    expect(await svc.get("app.ref")).toBe("updated");
  });

  test("resolveEntries handles nested objects without markers", async () => {
    const entries = {
      app: {
        nested: { deep: { value: 42 } },
      },
    };
    const provider = createTestProvider("p1", "platform", entries);
    const svc = await createWeaverConfigService({
      providers: [provider],
      environment: "dev",
    });

    const ns = await svc.getNamespace("app");
    expect(ns).toEqual({ nested: { deep: { value: 42 } } });
  });
});
