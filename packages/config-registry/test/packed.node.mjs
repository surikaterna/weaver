import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserGraphs } from "./packed-browser.mjs";
import { fixture, installConsumer, run, withConsumer } from "./packed-consumer-helper.mjs";
import { strictDeclarations } from "./packed-declarations.mjs";
import { exercise, internalExports, rootExports } from "./operation-support-fixture.mjs";

async function nodeConsumers(directory) {
  for (const cjs of [false, true]) {
    const filename = await fixture(directory, `runtime.${cjs ? "cjs" : "mjs"}`,
      `${cjs ? "const assert = require('node:assert/strict');" : "import assert from 'node:assert/strict';"}
      ${cjs ? "const support = require('@weaver-conf/config-registry'); const engine = require('@weaver-conf/config-engine'); const internalApi = require('@weaver-conf/config-registry/internal/server-adapter');"
        : "import * as support from '@weaver-conf/config-registry'; import * as engine from '@weaver-conf/config-engine'; import * as internalApi from '@weaver-conf/config-registry/internal/server-adapter';"}
      assert.deepEqual(Object.keys(support).sort(), ${JSON.stringify(rootExports)});
      assert.deepEqual(Object.keys(internalApi).sort(), ${JSON.stringify(internalExports)});
      for (const api of [support, internalApi]) { ${exercise} }
      console.log('packed runtime real registrations/reads/pages/validators passed');`);
    console.log(run(process.execPath, [filename], directory));
  }
}

test("empty tarball consumer: unusual OS-root path, ESM/CJS, strict declarations and complete browser graphs", async () => {
  const parent = await mkdtemp(join(tmpdir(), "weaver spaces % Unicode-雪-"));
  const sentinel = join(parent, "sibling");
  await mkdir(sentinel);
  await writeFile(join(sentinel, "keep"), "sentinel");
  try {
    await withConsumer(async directory => {
      await nodeConsumers(directory);
      await strictDeclarations(directory);
      await browserGraphs(directory);
    }, { parent });
    assert.deepEqual(await readdir(parent), ["sibling"]);
    assert.equal(await readFile(join(sentinel, "keep"), "utf8"), "sentinel");
  } finally { await rm(parent, { recursive: true, force: true }); }
});

for (const stage of ["pack", "write", "install", "resolution", "callback"]) {
  test(`packed consumer owns cleanup on ${stage} failure without replacing original error/sibling`, async () => {
    const parent = await mkdtemp(join(tmpdir(), "weaver-cleanup-"));
    const original = new Error(stage);
    await writeFile(join(parent, "sentinel"), "keep");
    const execute = (command, args, cwd) => {
      if (args[0] === stage) throw original;
      if (stage === "pack" || stage === "write") return "";
      return run(command, args, cwd);
    };
    const options = { parent, execute,
      ...(stage === "write" ? { write: async () => { throw original; } } : {}),
      ...(stage === "resolution" ? { resolve: async () => { throw original; } } : {}) };
    try {
      await assert.rejects(stage === "callback" ? withConsumer(() => { throw original; }, options)
        : installConsumer(options), error => error === original);
      assert.deepEqual(await readdir(parent), ["sentinel"]);
      assert.equal(await readFile(join(parent, "sentinel"), "utf8"), "keep");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
}
