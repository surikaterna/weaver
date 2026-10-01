import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceTextModule, SyntheticModule } from "node:vm";

function moduleOf(exports) {
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  });
}

async function captureCallbacks(sandbox, stage, original, cleanupFails) {
  const callbacks = [];
  const allocated = [];
  const filesystem = { ...fs,
    mkdtemp: async prefix => { const parent = await fs.mkdtemp(prefix); allocated.push(parent); return parent; },
    mkdir: async path => { if (stage === "mkdir") throw original; return fs.mkdir(path); },
    writeFile: async (...args) => { if (stage === "write") throw original; return fs.writeFile(...args); },
    rm: async (...args) => { await fs.rm(...args); if (cleanupFails) throw new Error("cleanup failure"); } };
  const source = await fs.readFile(new URL("./packed.node.mjs", import.meta.url), "utf8");
  const actual = new SourceTextModule(source);
  await actual.link(async specifier => {
    if (specifier === "node:fs/promises") return moduleOf(filesystem);
    if (specifier === "node:os") return moduleOf({ tmpdir: () => sandbox });
    if (specifier === "node:test") return moduleOf({ test: (name, callback) => callbacks.push({ name, callback }) });
    if (specifier.startsWith("node:")) return moduleOf(await import(specifier));
    return moduleOf({ browserGraphs: undefined, fixture: undefined, installConsumer: undefined,
      run: undefined, withConsumer: undefined, strictDeclarations: undefined,
      exercise: "", readProjectionExercise: "", exerciseDomainBoundaries: () => {}, internalExports: [], rootExports: [] });
  });
  await actual.evaluate();
  return { callbacks, allocated };
}

async function verifyCase(sandbox, target, stage, cleanupFails) {
  const original = new Error(`${target} sentinel ${stage}`);
  const { callbacks, allocated } = await captureCallbacks(sandbox, stage, original, cleanupFails);
  const selected = callbacks[target === "success" ? 0 : 1];
  assert.ok(selected.name.includes(target === "success" ? "empty tarball" : "pack failure"));
  await assert.rejects(selected.callback(), error => error === original);
  assert.equal(allocated.length, 1);
  await assert.rejects(fs.access(allocated[0]), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(sandbox), ["borrowed-sibling"]);
  assert.equal(await fs.readFile(join(sandbox, "borrowed-sibling"), "utf8"), "keep");
  console.log(`actual ${target} callback sentinel ${stage}, cleanupFails=${cleanupFails}: original error, parent removed, sibling preserved`);
}

export async function verifyParentCleanup() {
  const sandbox = await fs.mkdtemp(join(tmpdir(), "weaver-parent-regression-"));
  try {
    await fs.writeFile(join(sandbox, "borrowed-sibling"), "keep");
    for (const cleanupFails of [false, true]) {
      for (const [target, stage] of [["success", "mkdir"], ["success", "write"], ["failure", "write"]]) {
        await verifyCase(sandbox, target, stage, cleanupFails);
      }
    }
  } finally { await fs.rm(sandbox, { recursive: true, force: true }); }
}
