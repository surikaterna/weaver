import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertInstalled, packageDir, run, toolRequire } from "./consumer.mjs";

const ts = toolRequire("typescript");

export async function checkDeclarations(consumer, mode) {
  const node = mode === "node";
  const filename = join(consumer, `${mode}.${mode === "cjs" ? "cts" : "mts"}`);
  const fixture = join(packageDir, "test/packaging", node ? "node-fixture.mts" : "browser-fixture.mts");
  await writeFile(filename, await readFile(fixture, "utf8"));
  const browser = mode === "bundler";
  const options = {
    strict: true, skipLibCheck: false, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: browser ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: browser ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
    types: node ? ["node"] : [],
  };
  const program = ts.createProgram([filename], options);
  for (const source of program.getSourceFiles()) {
    if (source.fileName.includes("@weaver-conf")) await assertInstalled(source.fileName, consumer);
    if (!node) assert.ok(!source.fileName.includes("@types/node"), source.fileName);
  }
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const text = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => consumer, getNewLine: () => "\n",
  });
  assert.equal(diagnostics.length, 0, text);
}

export async function checkBrowserDeclarations(consumer) {
  await assert.rejects(access(join(consumer, "node_modules/@types/node")));
  for (const extension of ["d.ts", "d.cts"]) {
    const filename = join(consumer, `node_modules/@weaver-conf/config-engine/dist/index.${extension}`);
    await assertInstalled(filename, consumer);
    const declaration = await readFile(filename, "utf8");
    assert.doesNotMatch(declaration, /NodeJS|reference\s|["']node:/);
    assert.match(declaration, /interface NodeError extends Error/);
    for (const [field, type] of [["errno", "number"], ["code", "string"], ["path", "string"], ["syscall", "string"]]) {
      assert.match(declaration, new RegExp(`${field}\\?: ${type}`));
    }
  }
  for (const mode of ["esm", "cjs", "bundler"]) await checkDeclarations(consumer, mode);
}

export async function checkNodeDeclarations(consumer) {
  const { version } = toolRequire("@types/node/package.json");
  run("pnpm", ["add", "--save-dev", "--ignore-scripts", `@types/node@${version}`], consumer);
  await checkDeclarations(consumer, "node");
}
