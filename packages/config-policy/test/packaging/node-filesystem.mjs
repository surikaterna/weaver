import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserExports, record } from "./behavior.mjs";

export async function checkFilesystem(api, consumer, mode) {
  assert.deepEqual(Object.keys(api).sort(), [...browserExports, "createFileSystemOverrideTracker"].sort());
  const path = join(consumer, mode, "nested", "records.json");
  const options = { followUpDeadlineMs: 1000 };
  const tracker = api.createFileSystemOverrideTracker(path, options);
  assert.deepEqual(await tracker.listActive(), []);
  const created = await tracker.create(record());
  assert.deepEqual(created, { ...record(), followUpDeadline: "2026-09-30T00:00:01.000Z" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [created]);
  const reloaded = api.createFileSystemOverrideTracker(path, options);
  assert.deepEqual(await reloaded.listActive(), [created]);
  assert.deepEqual(await reloaded.listOverdue(created.followUpDeadline), []);
  assert.deepEqual(await reloaded.listOverdue("2026-09-30T00:00:02.000Z"), [created]);
  assert.equal(await reloaded.regularize("missing", "reviewer"), undefined);
  const regularized = await reloaded.regularize(created.id, "reviewer");
  assert.equal(regularized.regularizedBy, "reviewer");
  assert.ok(Number.isFinite(Date.parse(regularized.regularizedAt)));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [regularized]);
  const finalReload = api.createFileSystemOverrideTracker(path);
  assert.deepEqual(await finalReload.listActive(), []);
  assert.deepEqual(await finalReload.listOverdue("2027-01-01"), []);
  await writeFile(path, "{malformed");
  assert.deepEqual(await finalReload.listActive(), []);
  await writeFile(path, JSON.stringify([{ id: "invalid" }]));
  await assert.rejects(finalReload.listActive(), (error) => error.name === "ZodError");
}
