import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndependentCleanup } from "@weaver-conf/config-engine";
import { createInMemoryStorageProvider, createFileSystemStorageProvider } from "@weaver-conf/storage-providers";
import { createControlService } from "../../src/core/control-service.ts";
import { createSchemaRegistry } from "../../src/core/schema-registry.ts";
import { projectCanonicalRegistrations } from "../../src/core/canonical-projection.ts";

const cleanups = [];
afterEach(() => runIndependentCleanup(cleanups.splice(0).reverse()));

export async function fixtureStorage(profile) {
  assert.ok(["memory", "fs-restart"].includes(profile));
  const directory = profile === "fs-restart" ? await mkdtemp(join(tmpdir(), "weaver-schema-restart-")) : undefined;
  const filePath = directory ? join(directory, "entries.json") : undefined;
  const openStorage = (initialize = false) => filePath
    ? createFileSystemStorageProvider({ id: "control", layer: "control", writable: true, filePath, authority: { environment: "dev", initialize } })
    : createInMemoryStorageProvider({ id: "control", layer: "control" });
  const storage = openStorage(true);
  return { storage, filePath, verifyAfterTest(control, applicationProviders) {
    cleanups.push({ name: `schema fixture ${profile}`, async run() {
      let reopened;
      try {
        const catalog = (await storage.load()).entries._weaver.catalog;
        await control.close();
        if (!filePath) return;
        const bytes = await readFile(filePath, "utf8");
        const fresh = openStorage();
        assert.notEqual(fresh, storage);
        reopened = await createControlService({ providers: [fresh, ...applicationProviders], environment: "dev", controlLayer: "control" });
        assert.deepEqual((await fresh.load()).entries._weaver.catalog, catalog);
        const schemas = Object.fromEntries([...projectCanonicalRegistrations(catalog).state.schemas].map(([key, entry]) => [key, entry.schema]));
        assert.deepEqual(createSchemaRegistry({ configService: reopened.configuration }).listAll(), schemas);
        assert.equal(await readFile(filePath, "utf8"), bytes);
      } finally {
        await runIndependentCleanup([
          { name: "reopened owner", run: async () => { await reopened?.close(); } },
          { name: "original owner", run: () => control.close() },
          { name: "fixture directory", run: async () => { if (directory) await rm(directory, { recursive: true, force: true }); } },
        ]);
      }
    } });
  } };
}
