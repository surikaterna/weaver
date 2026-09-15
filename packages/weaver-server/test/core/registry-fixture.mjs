import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { runIndependentCleanup } from "@weaver-conf/config-engine";
import { createFileSystemStorageProvider } from "@weaver-conf/storage-providers";
import { createControlService } from "../../src/core/control-service.ts";
import { configuration, initialized } from "../validated-fixtures.mjs";

const cleanups = [];
afterEach(() => runIndependentCleanup(cleanups.splice(0).reverse()));

export async function registryFixture(profile = "memory") {
  assert.ok(["memory", "fs"].includes(profile));
  if (profile === "memory") return initialized();
  const directory = await mkdtemp(join(tmpdir(), "weaver-registry-fs-"));
  const filePath = join(directory, "entries.json");
  const platform = createFileSystemStorageProvider({ id: "platform", layer: "platform", writable: true, filePath, authority: { environment: "dev", initialize: true } });
  const providers = [platform];
  const control = await createControlService({ providers, environment: "dev" });
  cleanups.push({ name: "durable registry fixture", run: () => runIndependentCleanup([
    { name: "owner", run: () => control.close() },
    { name: "fixture files", run: () => rm(directory, { recursive: true, force: true }) },
  ]) });
  const state = configuration(control.binding, providers);
  state.infrastructure.generations.g1.providers[0] = { id: "platform", factory: "fs", options: { filePath } };
  assert.equal((await control.initialize(state)).success, true);
  assert.equal((await control.finalize(control.revision)).success, true);
  return { service: await control.application(), platform, providers, state };
}
