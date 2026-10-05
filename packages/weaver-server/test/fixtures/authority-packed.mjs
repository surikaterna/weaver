import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
export function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 120000,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) { throw new Error(`${command} ${args.join(" ")}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error }); }
}
async function closure(name, manifests = new Map()) {
  if (manifests.has(name)) return manifests;
  const source = join(root, "packages", name);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  manifests.set(name, { source, manifest });
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    if (dependency.startsWith("@weaver-conf/")) await closure(dependency.slice(13), manifests);
  return manifests;
}
async function prepare(directory) {
  const manifests = await closure("weaver-server"), dependencies = {};
  for (const [name, { source, manifest }] of manifests) {
    run("pnpm", ["pack", "--pack-destination", directory], source);
    const tarball = join(directory, `weaver-conf-${name}-${manifest.version}.tgz`);
    console.log(`authority packed sha256 ${manifest.name}@${manifest.version}: ${createHash("sha256").update(await readFile(tarball)).digest("hex")}`);
    dependencies[manifest.name] = `file:${tarball}`;
    for (const [dependency, version] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies }))
      if (!dependency.startsWith("@weaver-conf/")) dependencies[dependency] = version;
  }
  const server = manifests.get("weaver-server").manifest;
  for (const name of ["typescript", "@types/node", "@types/express"]) dependencies[name] = server.devDependencies[name];
  dependencies["@scompr/core"] = "0.2.0";
  dependencies["@scompr/types"] = "0.2.0";
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }));
  await writeFile(join(directory, "pnpm-workspace.yaml"), `packages: []\nlinkWorkspacePackages: false\nautoInstallPeers: false\noverrides:\n${Object.entries(dependencies).filter(([name, value]) => value.startsWith("file:") || name.startsWith("@scompr/")).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`).join("\n")}\n`);
  run("pnpm", ["install", "--offline", "--ignore-scripts", "--config.confirmModulesPurge=false"], directory);
  for (const name of ["core", "types"]) {
    const installed = JSON.parse(await readFile(join(directory, "node_modules/@scompr", name, "package.json"), "utf8"));
    assert.equal(installed.version, "0.2.0");
    console.log(`offline pinned @scompr/${name}@${installed.version}`);
  }
  const require = createRequire(join(directory, "package.json"));
  for (const { manifest } of manifests.values()) {
    const path = await realpath(require.resolve(manifest.name));
    assert.ok(path.startsWith(`${directory}${sep}node_modules${sep}`), path);
    console.log(`authority installed provenance ${manifest.name}: ${path}`);
  }
}

export function synchronousRequireProof(directory, name, member) {
    const script = `const assert = require("node:assert/strict");
      const path = require.resolve("@weaver-conf/${name}");
      assert.ok(path.startsWith(process.cwd() + "/node_modules/"));
      assert.ok(path.endsWith(".cjs"));
      const loaded = require("@weaver-conf/${name}");
      assert.equal(typeof loaded.${member}, "function");
      console.log("synchronous public require: " + path);`;
    console.log(run(process.execPath, ["--input-type=commonjs", "-e", script], directory));
}

function runtimeEdges(ts, text, filename) {
  const edges = new Set(), source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      edges.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) edges.add(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...edges].sort();
}

async function noticeProof(directory, name) {
  const path = join(directory, "node_modules/@weaver-conf", name, "THIRD_PARTY_NOTICES.md");
  const notice = await readFile(path, "utf8");
  assert.match(notice, /@scompr\/core.*0\.2\.0/);
  const license = notice.slice(notice.indexOf("MIT License\n"));
  const hash = createHash("sha1").update(`blob ${Buffer.byteLength(license)}\0`).update(license).digest("hex");
  assert.equal(hash, "4e2760ecb13e6bcbf21ed3548d504d4e8903e31f", "exact full upstream MIT blob");
  console.log(`installed notice ${path}: upstream LICENSE blob ${hash}`);
}

export async function artifactProof(directory) {
  const ts = createRequire(join(directory, "package.json"))("typescript");
  for (const name of ["weaver-server", "transport-scomp"]) {
    await noticeProof(directory, name);
    const dist = join(directory, "node_modules/@weaver-conf", name, "dist"), allEdges = new Set();
    for (const file of (await readdir(dist, { recursive: true })).filter((file) => /\.(?:js|cjs)$/.test(file)).sort()) {
      const text = await readFile(join(dist, file), "utf8");
      const edges = runtimeEdges(ts, text, file);
      for (const edge of edges) {
        assert.doesNotMatch(edge, /^@scompr\/(?:core|types)(?:\/|$)/, `${name}/${file}: broken external runtime edge`);
        allEdges.add(edge);
      }
      const retained = text.split("\n").filter((line) => /^\/\/ .*@scompr.*\/dist\//.test(line));
      assert.doesNotMatch(text, /^\/\/ .*node_modules\/.*(?:mongodb|simple-git|@weaver-conf\/transport-scomp)\//m);
      console.log(`artifact ${name}/${file}: external/local edges=${JSON.stringify(edges)}; retained upstream modules=${JSON.stringify(retained)}`);
    }
    if (name === "weaver-server") {
      for (const external of ["express", "@weaver-conf/config-service", "@weaver-conf/transport-scomp"])
        assert.ok(allEdges.has(external), `must remain external: ${external}`);
    }
  }
}
export async function withPackedServer(callback) {
  const directory = await mkdtemp(join(tmpdir(), "weaver-authority-packed-"));
  try { await prepare(directory); return await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export async function strictDeclarations(directory) {
  const require = createRequire(join(directory, "package.json"));
  const ts = require("typescript");
  for (const format of ["esm", "cjs"]) {
    const filename = join(directory, format === "esm" ? "strict.mts" : "strict.cts");
    await writeFile(filename, await readFile(new URL("authority-strict.mts", import.meta.url), "utf8"));
    const options = { strict: true, skipLibCheck: false, noEmit: true, types: ["node"],
      typeRoots: [join(directory, "node_modules/@types")], target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
    const program = ts.createProgram([filename], options);
    const resolved = ts.resolveModuleName("@weaver-conf/weaver-server", filename, options, ts.sys, undefined, undefined,
      format === "cjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext).resolvedModule;
    const expected = await realpath(join(directory, "node_modules/@weaver-conf/weaver-server/dist", format === "cjs" ? "index.d.cts" : "index.d.ts"));
    assert.equal(await realpath(resolved.resolvedFileName), expected, `strict ${format} declaration routing`);
    for (const source of program.getSourceFiles()) {
      if (source.fileName === filename) continue;
      assert.ok((await realpath(source.fileName)).startsWith(`${directory}${sep}node_modules${sep}`), source.fileName);
    }
    const errors = ts.getPreEmitDiagnostics(program);
    assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (name) => name, getCurrentDirectory: () => directory, getNewLine: () => "\n",
    }));
    console.log(`authority strict ${format}: ${expected}; skipLibCheck=false types=[node]; installed compiler`);
  }
}
