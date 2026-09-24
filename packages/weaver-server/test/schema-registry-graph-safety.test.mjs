import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileSystemStorageProvider,
  createInMemoryStorageProvider,
} from "@weaver-conf/storage-providers";
import { createWeaverConfigService } from "../src/core/config-service.ts";
import {
  createPersistentSchemaRegistry,
  createSchemaRegistry,
} from "../src/core/schema-registry.ts";
import {
  decodeSchemaGraph,
  encodeSchemaGraph,
} from "../src/core/schema-registry-schema-codec.ts";

const encoding = "weaver.configuration-property-schema-graph";

function diamond(
  depth,
  leaf = {
    type: "object",
    properties: { value: { type: "string", pattern: "^[a-z]+$" } },
    additionalProperties: true,
  },
) {
  let shared = leaf;
  for (let index = 0; index < depth; index++) {
    shared = {
      type: "object",
      additionalProperties: true,
      allOf: [shared, shared],
    };
  }
  return {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: true,
    allOf: [shared, shared],
  };
}

function registration(schema, serviceId = "svc") {
  return {
    serviceId,
    environment: "test",
    owner: { name: serviceId, contact: `${serviceId}@example.com` },
    schema,
    fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
  };
}

function fragmentRegistration(schema) {
  return {
    serviceId: "svc",
    providerId: "plugin",
    slotPath: "/plugins",
    environment: "test",
    owner: { name: "plugin", contact: "plugin@example.com" },
    schema,
  };
}

function trackedProvider(initialEntries = {}) {
  const provider = createInMemoryStorageProvider({
    id: "platform",
    layer: "platform",
    initialEntries,
  });
  let writes = 0;
  const write = provider.write.bind(provider);
  provider.write = async (...args) => {
    const result = await write(...args);
    if (result.success) writes++;
    return result;
  };
  return { provider, writes: () => writes };
}

async function harness(provider) {
  const service = await createWeaverConfigService({
    providers: [provider],
    environment: "test",
  });
  return { service, registry: await createPersistentSchemaRegistry({ configService: service }) };
}

function expectRestoredAliases(schema, depth) {
  let current = schema.allOf[0];
  expect(current).toBe(schema.allOf[1]);
  for (let index = 0; index < depth; index++) {
    expect(current.allOf[0]).toBe(current.allOf[1]);
    current = current.allOf[0];
  }
}

async function expectPatchEffects(service, registry, tracked) {
  let notifications = 0;
  const unsubscribe = service.onDelta(() => notifications++);
  const initialWrites = tracked.writes();
  for (const path of ["/svc/value", "/svc/plugins/plugin/value"]) {
    const revision = service.revision;
    expect(
      await service.patchRegisteredPath("platform", path, "next", {
        schemaRegistry: registry,
      }),
    ).toEqual({ success: true });
    expect(service.revision).not.toBe(revision);
    const acceptedRevision = service.revision;
    const invalid = await service.patchRegisteredPath("platform", path, "BLOCKED", {
      schemaRegistry: registry,
    });
    expect(invalid.success).toBe(false);
    expect(invalid.error.code).toBe("VALIDATION_ERROR");
    expect(service.revision).toBe(acceptedRevision);
  }
  expect([tracked.writes() - initialWrites, notifications]).toEqual([2, 2]);
  unsubscribe();
  return { writes: 2, notifications: 2, revisions: 2 };
}

function recordResources(mode, depth, schema, effects) {
  const encoded = encodeSchemaGraph(schema);
  const json = JSON.stringify(encoded);
  console.info(
    `GRAPH_RESOURCE ${JSON.stringify({
      mode,
      depth,
      inputIdentities: depth + 4,
      parsedIdentities: encoded.nodes.length,
      encodedNodes: encoded.nodes.length,
      jsonBytes: Buffer.byteLength(json),
      rssBytes: process.memoryUsage.rss(),
      ...effects,
      digest: createHash("sha256").update(json).digest("hex"),
    })}`,
  );
}

describe("schema graph v1 codec", () => {
  it("emits the exact deterministic depth-2 golden in public field order", () => {
    const shared = { type: "string", title: "leaf" };
    const distinct = { type: "string", title: "leaf" };
    const schema = {
      type: "object",
      title: "root",
      properties: { z: shared, a: distinct },
      additionalProperties: shared,
      allOf: [shared, { type: "string", allOf: [shared, shared] }],
    };
    const expected = {
      encoding,
      version: 1,
      root: 0,
      nodes: [
        {
          type: "object",
          title: "root",
          properties: { z: 1, a: 2 },
          additionalProperties: 1,
          allOf: [1, 3],
        },
        { type: "string", title: "leaf" },
        { type: "string", title: "leaf" },
        { type: "string", allOf: [1, 1] },
      ],
    };

    const first = encodeSchemaGraph(schema);
    const second = encodeSchemaGraph(schema);
    expect(first).toEqual(expected);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const decoded = decodeSchemaGraph(first);
    expect(decoded.properties.z).toBe(decoded.additionalProperties);
    expect(decoded.properties.z).toBe(decoded.allOf[0]);
    expect(decoded.properties.z).toBe(decoded.allOf[1].allOf[0]);
    expect(decoded.properties.z).not.toBe(decoded.properties.a);
  });

  it("rejects malformed envelopes, references, cycles, and roots", () => {
    const valid = { encoding, version: 1, root: 0, nodes: [{ type: "object" }] };
    const cases = [
      { ...valid, encoding: "unknown" },
      { ...valid, version: 2 },
      { ...valid, root: 1 },
      { ...valid, nodes: [] },
      { ...valid, extra: true },
      { ...valid, nodes: [{ type: "object", extra: true }] },
      { ...valid, nodes: [{ type: "object", not: 1 }] },
      { ...valid, nodes: [{ type: "object" }, { type: "string" }] },
      { ...valid, nodes: [{ type: "object", not: 0 }] },
      { ...valid, nodes: [{ type: "string" }] },
      { ...valid, nodes: [{ type: "object", properties: [] }] },
    ];
    const sparse = Array(2);
    sparse[0] = { type: "object" };
    cases.push({ ...valid, nodes: sparse });
    for (const malformed of cases) expect(() => decodeSchemaGraph(malformed)).toThrow();
  });

  it("stays linear and compact at depth 40", () => {
    const encoded = encodeSchemaGraph(diamond(40));
    expect(encoded.nodes).toHaveLength(44);
    expect(JSON.stringify(encoded).length).toBeLessThan(64 * 1024);
    expectRestoredAliases(decodeSchemaGraph(encoded), 40);
  });
});

describe("public graph registration pipelines", () => {
  it.each([10, 20, 30, 40])(
    "registers shared depth %i through transient service and fragment APIs",
    async (depth) => {
      const tracked = trackedProvider({
        svc: { value: "old", plugins: { plugin: { value: "old" } } },
      });
      const service = await createWeaverConfigService({
        providers: [tracked.provider],
        environment: "test",
      });
      const registry = createSchemaRegistry({ configService: service });
      const schema = diamond(depth);
      expect((await registry.register(registration(schema))).success).toBe(true);
      expect((await registry.register(fragmentRegistration(schema))).success).toBe(true);
      expectRestoredAliases(await registry.getSchema("svc", "test"), depth);
      const fragment = await registry.resolveAnchor("/svc/plugins/plugin", "test");
      expectRestoredAliases(fragment.schema, depth);
      const effects = await expectPatchEffects(service, registry, tracked);
      recordResources(
        "transient-memory",
        depth,
        await registry.getSchema("svc", "test"),
        effects,
      );
    },
  );

  it.each([10, 20, 30, 40])(
    "persists, restarts, and validates effects at shared depth %i",
    async (depth) => {
      const tracked = trackedProvider({
        svc: { value: "old", plugins: { plugin: { value: "old" } } },
      });
      const first = await harness(tracked.provider);
      const schema = diamond(depth);
      expect((await first.registry.register(registration(schema))).success).toBe(true);
      expect((await first.registry.register(fragmentRegistration(schema))).success).toBe(true);
      const writesAfterRegistration = tracked.writes();
      const restarted = await createPersistentSchemaRegistry({ configService: first.service });
      expect(tracked.writes()).toBe(writesAfterRegistration);
      expectRestoredAliases(await restarted.getSchema("svc", "test"), depth);
      expectRestoredAliases(
        (await restarted.resolveAnchor("/svc/plugins/plugin", "test")).schema,
        depth,
      );
      expect(Object.keys(restarted.listAll())).toHaveLength(2);
      const repeated = await restarted.register(registration(schema));
      expect(repeated).toEqual(
        expect.objectContaining({
          success: true,
          isNewSchema: false,
          hasBreakingChanges: false,
        }),
      );
      const effects = await expectPatchEffects(first.service, restarted, tracked);
      recordResources(
        "persistent-memory-restart",
        depth,
        await restarted.getSchema("svc", "test"),
        effects,
      );
    },
  );

  it("persists compact aliases through a file-system restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weaver-schema-graph-"));
    const filePath = join(directory, "platform.json");
    try {
      const provider = createFileSystemStorageProvider({
        id: "platform",
        layer: "platform",
        filePath,
        writable: true,
      });
      const first = await harness(provider);
      expect((await first.registry.register(registration(diamond(40)))).success).toBe(true);
      const bytes = await readFile(filePath, "utf8");
      expect(bytes.length).toBeLessThan(64 * 1024);
      const restarted = await harness(
        createFileSystemStorageProvider({
          id: "platform",
          layer: "platform",
          filePath,
          writable: true,
        }),
      );
      expectRestoredAliases(await restarted.registry.getSchema("svc", "test"), 40);
      expect(await readFile(filePath, "utf8")).toBe(bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hydrates legacy inline bytes and rewrites every schema only after registration", async () => {
    const metadata = {
      serviceId: "svc",
      servicePath: "/svc",
      environment: "test",
      providerId: "svc",
      owner: { name: "svc", contact: "svc@example.com" },
    };
    const legacy = {
      _weaver: {
        registry: {
          schemas: {
            environments: {
              test: {
                schemas: {
                  "/svc": { kind: "service", schema: { type: "object" }, metadata },
                },
                slots: {},
              },
            },
          },
        },
      },
    };
    const tracked = trackedProvider(legacy);
    const first = await harness(tracked.provider);
    expect(tracked.writes()).toBe(0);
    expect(await first.registry.getSchema("svc", "test")).toEqual({ type: "object" });
    const unchanged = await createPersistentSchemaRegistry({ configService: first.service });
    expect(unchanged.listAll()).toEqual(first.registry.listAll());
    expect(tracked.writes()).toBe(0);
    expect((await first.registry.register(registration({ type: "object" }))).success).toBe(true);
    expect(tracked.writes()).toBe(1);
    const persisted = await first.service.get("_weaver.registry.schemas");
    expect(persisted.environments.test.schemas["/svc"].schema).toEqual({
      encoding,
      version: 1,
      root: 0,
      nodes: [{ type: "object" }],
    });
  });

  it("rejects malformed v1 hydration without writes or partial activation", async () => {
    const metadata = {
      serviceId: "svc",
      servicePath: "/svc",
      environment: "test",
      providerId: "svc",
      owner: { name: "svc", contact: "svc@example.com" },
    };
    const entries = {
      _weaver: {
        registry: {
          schemas: {
            environments: {
              test: {
                schemas: {
                  "/svc": {
                    kind: "service",
                    schema: { encoding, version: 1, root: 0, nodes: [{ type: "object", not: 9 }] },
                    metadata,
                  },
                },
                slots: {},
              },
            },
          },
        },
      },
    };
    const tracked = trackedProvider(entries);
    const service = await createWeaverConfigService({
      providers: [tracked.provider],
      environment: "test",
    });
    await expect(createPersistentSchemaRegistry({ configService: service })).rejects.toThrow(
      "Invalid schema node reference",
    );
    expect(tracked.writes()).toBe(0);
  });
});
