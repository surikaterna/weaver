import assert from "node:assert/strict";
import { test } from "node:test";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPrivateJson } from "../src/bootstrap/seed-file.ts";
import { createStandaloneFixture } from "./standalone-fixture.ts";

test("dzb8 actual descriptor reads enforce byte limit after growth and read through actual EOF", async (context) => {
  const fixture = await createStandaloneFixture();
  const path = join(fixture.directory, "private.json");
  let probe;
  try {
    await writeFile(path, "{}", { mode: 0o600 });
    probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe);
    const stat = prototype.stat;
    let replacement = "{}" + " ".repeat(17);
    const spy = context.mock.method(prototype, "stat", async function (...args) {
      const info = await stat.apply(this, args);
      await writeFile(path, replacement);
      return info;
    });
    await assert.rejects(readPrivateJson(path, 16), { code: "FORBIDDEN" });
    replacement = "{}";
    assert.deepEqual(await readPrivateJson(path, 64), {});
    spy.mock.restore();
    assert.deepEqual(await readPrivateJson(path, 2), {});
  } finally { await probe?.close(); await fixture.dispose(); }
});
