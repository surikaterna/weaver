import assert from "node:assert/strict";
import { access, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { fixture, requireTool } from "./packed-consumer-helper.mjs";

const ts = requireTool("typescript");
const text = `
import { createCanonicalSchemaRegistry, createRegisteredReadProjection, registeredReadProjectionContextSchema,
  registeredReadProjectionSchema, type RegisteredReadProjection, schemaWriteSupport, structuralSupportSchema,
  type StructuralSupport, type CanonicalSchemaRegistryReader } from '@weaver-conf/config-registry';
import { createRegistryAdapter } from '@weaver-conf/config-registry/internal/server-adapter';
import { resolveConfigurationSnapshot, validateEffectiveConfiguration, validatePartialConfiguration } from '@weaver-conf/config-engine';
import { canonicalConfigurationPathSchema, hydratedConfigurationInspectionSchema } from '@weaver-conf/config-types';
import * as types from '@weaver-conf/config-types';
import * as engine from '@weaver-conf/config-engine';
import type { z } from 'zod';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IdentifierInput = Assert<Equal<z.input<typeof types.serviceIdSchema>, string>>;
type RelativeOutput = Assert<Equal<z.output<typeof types.relativeConfigurationPathSchema>, readonly [string, ...string[]]>>;
type CanonicalOutput = Assert<Equal<z.output<typeof types.canonicalConfigurationPathSchema>, types.CanonicalConfigurationPath>>;
types.serviceIdSchema.min(2); types.providerIdSchema.regex(/panel/);
types.relativeConfigurationPathSchema.out.unwrap().rest(types.providerIdSchema);
types.configurationServiceIdentitySchema.out.unwrap().pick({ environment: true });
types.configurationServiceIdentitySchema.out.unwrap().omit({ scopePath: true });
types.configurationServiceIdentitySchema.out.unwrap().extend({ revision: types.hydratedConfigurationReaderSchema.out.shape.revision });
types.hydratedConfigurationInspectionSchema.out.unwrap().safeExtend({ revision: types.hydratedConfigurationReaderSchema.out.shape.revision });
engine.resolutionOriginSchema.out.unwrap().shape.rank.finite();
engine.canonicalConfigPathSchema.out.unwrap().shape.storageKey.min(1);
registeredReadProjectionSchema.out.pick({ entries: true });
registeredReadProjectionContextSchema.out.unwrap().shape.revision.min(1);
const registry: CanonicalSchemaRegistryReader = createCanonicalSchemaRegistry({ defaultEnvironment: 'dev' });
const adapter = createRegistryAdapter({ defaultEnvironment: 'dev' });
const context = registeredReadProjectionContextSchema.parse({ identity: { environment: 'dev', scopePath: [] }, revision: 'r' });
const projection: RegisteredReadProjection = createRegisteredReadProjection(registry,
  resolveConfigurationSnapshot({ configuredRanks: [0], layers: [], ceilings: [] }), context);
const path = canonicalConfigurationPathSchema.parse('/example');
projection.entries(); projection.getNamespace(path); projection.get(path); projection.getAtLayer('base', path);
hydratedConfigurationInspectionSchema.parse(projection.inspect(path)); registeredReadProjectionSchema.parse(projection);
const result: StructuralSupport = schemaWriteSupport({ type: 'boolean' }, [], true, true, false);
structuralSupportSchema.parse(result);
const tupleSupport: StructuralSupport = schemaWriteSupport(
  { type: 'array', items: [{ type: 'boolean' }] }, ['1'], true, [], []);
const branchSupport: StructuralSupport = schemaWriteSupport(
  { type: 'object', anyOf: [{ type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }] },
  ['enabled'], true, { enabled: true }, {});
structuralSupportSchema.parse(tupleSupport); structuralSupportSchema.parse(branchSupport);
// @ts-expect-error Structural support is not a governed writer.
registry.set('enabled', true);
// @ts-expect-error The support result must preserve boolean fields.
const wrong: StructuralSupport = { declared: 'yes', arrayIndex: false, ambiguous: false };
void adapter; void wrong; void validateEffectiveConfiguration; void validatePartialConfiguration;
`;

async function assertResolution(directory, filename, options, program, mode, specifier, stem) {
  const resolutionMode = mode === "cjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
  const expected = await realpath(join(directory, "node_modules/@weaver-conf/config-registry/dist",
    `${stem}.${mode === "cjs" ? "d.cts" : "d.ts"}`));
  const resolved = ts.resolveModuleName(specifier, filename, options, ts.sys,
    undefined, undefined, resolutionMode).resolvedModule;
  assert.ok(resolved, `${mode}: ${specifier}`);
  assert.equal(await realpath(resolved.resolvedFileName), expected);
  const imported = program.getSourceFile(filename).statements.find(statement =>
    ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === specifier);
  const symbol = program.getTypeChecker().getSymbolAtLocation(imported.moduleSpecifier);
  assert.equal(await realpath(symbol.declarations[0].fileName), expected);
  console.log(`exact packed ${mode} declaration: ${specifier} -> ${expected}`);
}

async function checkProgram(directory, mode) {
  const filename = await fixture(directory, `strict.${mode === "cjs" ? "cts" : "mts"}`, text);
  const bundler = mode === "bundler";
  const options = { strict: true, skipLibCheck: false, noEmit: true, types: [],
    target: ts.ScriptTarget.ES2022,
    module: bundler ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: bundler ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext };
  const program = ts.createProgram([filename], options);
  for (const [suffix, stem] of [["", "index"], ["/internal/server-adapter", "internal/server-adapter"]]) {
    await assertResolution(directory, filename, options, program, mode, `@weaver-conf/config-registry${suffix}`, stem);
  }
  for (const source of program.getSourceFiles()) {
    assert.doesNotMatch(source.fileName, /@types[\/]node/);
    if (!source.fileName.includes("@weaver-conf") && !source.fileName.includes("/zod/")) continue;
    const path = await realpath(source.fileName);
    assert.ok(path.startsWith(`${directory}${sep}node_modules${sep}`), path);
    console.log(`packed ${mode} declaration closure: ${path}`);
  }
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => directory, getNewLine: () => "\n" }));
  console.log(`strict ${mode}: types=[] skipLibCheck=false, no ambient shims`);
}

export async function strictDeclarations(directory) {
  await assert.rejects(access(join(directory, "node_modules/@types/node")), { code: "ENOENT" });
  for (const mode of ["esm", "cjs", "bundler"]) await checkProgram(directory, mode);
}
