import assert from "node:assert/strict";
import { access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fixture, requireTool } from "./packed-consumer-helper.mjs";

const ts = requireTool("typescript");
const declarationFixture = `
import { createWeaverClient, createLocalTransport, createIndexedDbPersistence,
createHttpTransport, type WeaverClientPersistence } from "@weaver-conf/weaver-client/browser";
import { createFileSystemPersistence, type FileSystemPersistenceOptions } from "@weaver-conf/weaver-client";
// @ts-expect-error The browser boundary must not expose filesystem persistence.
import { createFileSystemPersistence as forbidden } from "@weaver-conf/weaver-client/browser";
// @ts-expect-error Node-only options must not leak either.
import type { FileSystemPersistenceOptions as ForbiddenOptions } from "@weaver-conf/weaver-client/browser";
const persistence: WeaverClientPersistence = createIndexedDbPersistence({ dbName: "test" });
const options: FileSystemPersistenceOptions = { directory: "cache" };
const nodePersistence: WeaverClientPersistence = createFileSystemPersistence(options);
const transport = createLocalTransport({ snapshot: { entries: {}, scopes: {}, revision: "1", timestamp: "now" } });
async function boot() {
  const client = await createWeaverClient({ transport, persistence });
  const value: boolean | undefined = client.get<boolean>("app.enabled");
  await client.close();
  return value;
}
void boot; void nodePersistence; void createHttpTransport({ baseUrl: "https://example.invalid" });
`;

async function assertBrowserResolution(directory, filename, options, program, mode) {
  const specifier = "@weaver-conf/weaver-client/browser";
  const resolutionMode = mode === "cjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
  const expected = await realpath(join(directory, "node_modules", specifier.replace("/browser", ""),
    "dist", mode === "cjs" ? "browser.d.cts" : "browser.d.ts"));
  const resolved = ts.resolveModuleName(specifier, filename, options, ts.sys,
    undefined, undefined, resolutionMode).resolvedModule;
  assert.ok(resolved, `${mode}: browser subpath must resolve`);
  assert.equal(await realpath(resolved.resolvedFileName), expected);
  const source = program.getSourceFile(filename);
  const imported = source.statements.find(statement => ts.isImportDeclaration(statement)
    && statement.moduleSpecifier.text === specifier);
  const symbol = program.getTypeChecker().getSymbolAtLocation(imported.moduleSpecifier);
  assert.ok(symbol?.declarations?.length, `${mode}: actual program import must resolve`);
  assert.equal(await realpath(symbol.declarations[0].fileName), expected);
  console.log(`exact ${mode} resolver (${resolutionMode === ts.ModuleKind.CommonJS ? "CommonJS" : "ESNext"}): ${expected}`);
}

async function checkProgram(directory, mode) {
  const filename = await fixture(directory, `types-${mode}.${mode === "cjs" ? "cts" : "mts"}`, declarationFixture);
  const bundler = mode === "bundler";
  const options = {
    strict: true, skipLibCheck: false, noEmit: true, types: [],
    target: ts.ScriptTarget.ES2022,
    module: bundler ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: bundler ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
  };
  const program = ts.createProgram([filename], options);
  await assertBrowserResolution(directory, filename, options, program, mode);
  for (const source of program.getSourceFiles()) {
    assert.ok(!source.fileName.includes("@types/node"), source.fileName);
    if (!source.fileName.includes("@weaver-conf")) continue;
    const resolved = await realpath(source.fileName);
    assert.ok(resolved.startsWith(`${directory}/node_modules/`), resolved);
    console.log(`packed ${mode} declaration: ${resolved}`);
  }
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => directory, getNewLine: () => "\n",
  }));
  console.log(`strict ${mode}: types=[] skipLibCheck=false passed without Node ambient types`);
}

export async function strictDeclarations(directory) {
  await assert.rejects(access(join(directory, "node_modules/@types/node")), { code: "ENOENT" });
  for (const mode of ["esm", "cjs", "bundler"]) await checkProgram(directory, mode);
}
