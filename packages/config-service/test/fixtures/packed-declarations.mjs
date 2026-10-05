import assert from "node:assert/strict";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tooling } from "./packed-consumer.mjs";

const ts = tooling("typescript");
async function check(directory, mode) {
  const filename = join(directory, `strict.${mode === "cjs" ? "cts" : "mts"}`);
  await writeFile(filename, await readFile(new URL("strict.mts", import.meta.url), "utf8"));
  const bundler = mode === "bundler";
  const options = { strict: true, skipLibCheck: false, noEmit: true, types: [], target: ts.ScriptTarget.ES2022, module: bundler ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext, moduleResolution: bundler ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext };
  const program = ts.createProgram([filename], options);
  const expected = await realpath(join(directory, "node_modules/@weaver-conf/config-service/dist", mode === "cjs" ? "index.d.cts" : "index.d.ts"));
  const resolved = ts.resolveModuleName("@weaver-conf/config-service", filename, options, ts.sys, undefined, undefined, mode === "cjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext).resolvedModule;
  assert.equal(await realpath(resolved.resolvedFileName), expected);
  const imported = program.getSourceFile(filename).statements.find((node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text === "@weaver-conf/config-service");
  assert.equal(await realpath(program.getTypeChecker().getSymbolAtLocation(imported.moduleSpecifier).declarations[0].fileName), expected);
  const admissionExpected = await realpath(join(directory, "node_modules/@weaver-conf/config-service/dist", mode === "cjs" ? "admission.d.cts" : "admission.d.ts"));
  const admission = ts.resolveModuleName("@weaver-conf/config-service/admission", filename, options, ts.sys, undefined, undefined, mode === "cjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext).resolvedModule;
  assert.equal(await realpath(admission.resolvedFileName), admissionExpected);
  for (const source of program.getSourceFiles()) {
    assert.doesNotMatch(source.fileName, /@types[\/]node/);
    if (source.fileName.includes("@weaver-conf") || source.fileName.includes("/zod/")) assert.ok((await realpath(source.fileName)).startsWith(`${directory}${sep}node_modules${sep}`));
  }
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (name) => name, getCurrentDirectory: () => directory, getNewLine: () => "\n" }));
  console.log(`strict installed ${mode}: ${expected}; types=[] skipLibCheck=false`);
  console.log(`strict installed admission ${mode}: ${admissionExpected}; types=[] skipLibCheck=false`);
}
export async function strictDeclarations(directory) {
  await assert.rejects(access(join(directory, "node_modules/@types/node")), { code: "ENOENT" });
  for (const mode of ["esm", "cjs", "bundler"]) await check(directory, mode);
}
