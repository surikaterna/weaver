import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { installConsumer, run } from "./packed-consumer-helper.mjs";
import { strictDeclarations } from "./packed-declarations.mjs";

async function withParent(callback) {
  await mkdir("/tmp/opencode", { recursive: true });
  const parent = await mkdtemp("/tmp/opencode/client space % 雪-");
  try {
    await writeFile(join(parent, "sentinel"), "retain-me");
    await callback(parent);
    assert.deepEqual(await readdir(parent), ["sentinel"]);
    assert.equal(await readFile(join(parent, "sentinel"), "utf8"), "retain-me");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

for (const failure of ["pack", "install", "resolution"]) {
  test(`setup ${failure} failure removes owned consumer and preserves original error/sibling`, async () => {
    await withParent(async parent => {
      const original = new Error(`injected ${failure} failure`);
      let allocated;
      const execute = (command, args, cwd) => {
        allocated = args[0] === "pack" ? args[2] : cwd;
        if (args[0] === failure) throw original;
        if (failure === "resolution" && args[0] === "install") return "";
        return run(command, args, cwd);
      };
      await assert.rejects(installConsumer({ parent, execute }), error => {
        if (failure === "resolution") assert.equal(error.code, "MODULE_NOT_FOUND");
        else assert.equal(error, original);
        return true;
      });
      assert.ok(allocated.startsWith(`${parent}/weaver-browser-packed-`));
      assert.deepEqual(await readdir(parent), ["sentinel"]);
    });
  });
}

test("successful setup transfers cleanup ownership and resolves declarations under space/percent/Unicode path", async () => {
  await withParent(async parent => {
    const consumer = await installConsumer({ parent });
    try {
      assert.ok((await readdir(parent)).includes(consumer.slice(parent.length + 1)));
      await strictDeclarations(consumer);
    } finally {
      await rm(consumer, { recursive: true, force: true });
    }
  });
});
