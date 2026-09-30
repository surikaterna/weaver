import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertInstalled, run, toolRequire } from "./packed-consumer-helper.mjs";

const ts = toolRequire("typescript");
export async function checkDeclarations(directory, mode) {
  const text = await readFile(new URL("./root-consumer.mts", import.meta.url), "utf8");
  const filename = join(directory, `strict.${mode === "cjs" ? "cts" : "mts"}`);
  await writeFile(filename, text);
  const bundler = mode === "bundler";
  const options = { strict: true, skipLibCheck: false, types: [], target: ts.ScriptTarget.ES2022,
    module: bundler ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: bundler ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
    outDir: join(directory, mode) };
  const program = ts.createProgram([filename], options);
  for (const source of program.getSourceFiles()) {
    assert.doesNotMatch(source.fileName, /@types[\/]node/);
    if (source.fileName.includes("node_modules") && !source.fileName.startsWith(ts.getDefaultLibFilePath(options).replace(/[^/]+$/, ""))) {
      await assertInstalled(source.fileName, directory);
    }
  }
  for (const specifier of ["@weaver-conf/config-engine", "@weaver-conf/config-types"]) {
    const resolved = ts.resolveModuleName(specifier, filename, options, ts.sys, undefined,
      undefined, mode === "cjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext).resolvedModule;
    assert.ok(resolved, specifier);
    if (specifier === "@weaver-conf/config-engine") assert.match(resolved.resolvedFileName, /index\.d\.ts$/);
    await assertInstalled(resolved.resolvedFileName, directory);
    const statement = program.getSourceFile(filename).statements.find(statement =>
      ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === specifier);
    const symbol = program.getTypeChecker().getSymbolAtLocation(statement.moduleSpecifier);
    await assertInstalled(symbol.declarations[0].fileName, directory);
  }
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...program.emit().diagnostics];
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => directory, getNewLine: () => "\n" }));
  if (!bundler) run(process.execPath, [join(directory, mode, `strict.${mode === "cjs" ? "cjs" : "mjs"}`)], directory);
   console.log(`strict ${mode}: skipLibCheck=false types=[]; tooling and snapshot fixture; inherited root index.d.ts`);
}

export async function strictDeclarations(directory) {
  await assert.rejects(access(join(directory, "node_modules/@types/node")), { code: "ENOENT" });
  for (const mode of ["esm", "cjs", "bundler"]) await checkDeclarations(directory, mode);
}
