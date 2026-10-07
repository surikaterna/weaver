import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(root, "package.json"));
const ts = require("typescript");
const domains = [
  ["config-types", "schemas-registration-paths", ["serviceIdSchema", "providerIdSchema", "registrationEnvironmentSchema", "publicConfigPathSchema", "slotPathSchema"]],
  ["config-types", "schemas-service-paths", ["canonicalConfigurationPathSchema", "relativeConfigurationPathSchema"]],
  ["config-types", "schemas-service-capabilities", ["configurationServiceIdentitySchema", "configurationInspectionValueSchema", "configurationLayerContributionSchema", "hydratedConfigurationInspectionSchema"]],
  ["config-engine", "snapshot-contracts", ["resolutionPathSchema", "resolutionOriginSchema", "resolutionLayerSchema", "resolutionCeilingSchema", "resolutionSnapshotInputSchema", "resolutionContributionSchema", "configurationSnapshotSchema", "resolvedPathInspectionSchema"]],
  ["config-registry", "registered-read-contracts", ["registeredReadProjectionContextSchema"]],
  ["config-engine", "registration-paths", ["canonicalConfigPathSchema"]],
];

test("native contracts retain historical fields and explicitly migrate captured-reader boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-domain-types-"));
  try {
    const before = join(directory, "before"); await mkdir(before);
    const archive = execFileSync("git", ["archive", "443ab01efb4c8f8226ab797e56655ba85e255593",
      "packages/config-types/src", "packages/config-engine/src", "packages/config-registry/src"], { cwd: root });
    const tar = join(directory, "before.tar"); await writeFile(tar, archive);
    execFileSync("tar", ["-xf", tar, "-C", before]);
    const lines = ["import type { z } from 'zod';", "type Normalize<T> = T extends (...args: never[])=>unknown ? T : T extends object ? { [K in keyof T]: Normalize<T[K]> } : T;",
      "type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;", "type Assert<T extends true> = T;",
      "type StripSources<T> = T extends string | number | boolean ? T : T extends readonly unknown[] ? { [K in keyof T]: StripSources<T[K]> } : T extends object ? { [K in keyof T as K extends 'source'|'sourcePath'|'effectiveSourcePath'|'effectiveSource'|'namespace'|'viewId' ? never : K]: StripSources<T[K]> } : T;",
      `import * as Readers from '${join(root, "packages/config-types/src/schemas-service-readers")}';`,
      `import type { ConfigurationNamespace, ConfigurationReader, ConfigurationService } from '${join(root, "packages/config-types/src/index")}';`];
    domains.forEach(([pkg, module, names], index) => {
      lines.push(`import * as B${index} from '${join(before, "packages", pkg, "src", module)}';`);
      lines.push(`import * as A${index} from '${join(root, "packages", pkg, "src", module)}';`);
      for (const name of names) {
        for (const direction of ["input", "output"]) {
          let b = `z.${direction}<typeof B${index}.${name}>`, a = `z.${direction}<typeof A${index}.${name}>`;
          if (direction === "output") {
            if (name === "relativeConfigurationPathSchema") b = "readonly string[]";
            else a = `StripSources<${a}>`;
            if (name === "hydratedConfigurationInspectionSchema") {
              lines.push(`type ${name}_path = Assert<Equal<z.output<typeof A${index}.${name}>['path'], ConfigurationNamespace>>;`);
              a = `Omit<${a}, 'path'>`; b = `Omit<${b}, 'path'>`;
            }
          }
          lines.push(`type ${name}_${direction}_forward = Assert<[${b}] extends [${a}] ? true : false>;`);
          lines.push(`type ${name}_${direction}_reverse = Assert<[${a}] extends [${b}] ? true : false>;`);
          lines.push(`type ${name}_${direction} = Assert<Equal<Normalize<${b}>,Normalize<${a}>>>;`);
        }
      }
    });
    lines.push(
      "A0.serviceIdSchema.min(2); A0.providerIdSchema.regex(/panel/);",
      "A1.relativeConfigurationPathSchema.out.unwrap().min(0);",
      "A2.configurationServiceIdentitySchema.out.unwrap().pick({ environment: true });",
      "A2.configurationServiceIdentitySchema.out.unwrap().omit({ scopePath: true });",
      "A2.configurationServiceIdentitySchema.out.unwrap().extend({ revision: Readers.configurationReaderSchema.out.unwrap().shape.revision });",
      "A3.resolutionOriginSchema.out.unwrap().shape.rank.finite();",
      "A4.registeredReadProjectionSchema.out.pick({ entries: true });",
      "A4.registeredReadProjectionContextSchema.out.unwrap().shape.revision.min(1);",
      "A5.canonicalConfigPathSchema.out.unwrap().shape.storageKey.min(1);",
      "type ReaderContract = Assert<Equal<Normalize<z.output<typeof Readers.configurationReaderSchema>>, Normalize<Readonly<ConfigurationReader>>>>;",
      "type LifecycleContract = Assert<Equal<Normalize<z.output<typeof A2.configurationServiceSchema>>, Normalize<{ -readonly [K in keyof ConfigurationService]: ConfigurationService[K] }>>>;",
      "type NoRetiredFactories = Assert<Equal<Extract<keyof typeof A2, 'hydratedConfigurationReaderSchema'|'hydratedConfigurationServiceSchema'|'hydratedScopedConfigurationServiceSchema'|'hydratedServiceConfigurationServiceSchema'>, never>>;",
      "type LifecycleKeys = Assert<Equal<keyof ConfigurationService, 'mode'|'degradedProviders'|'reloadProvider'|'flush'|'dispose'|'restartState'|'acknowledgeRestart'>>;",
      "type EventKinds = Assert<Equal<z.output<typeof A2.configurationReaderChangeSchema>['kind'], 'effective'|'layer'|'invalidation'>>;",
      "type NoEffectiveAlias = Assert<Equal<Extract<keyof typeof A2, 'configurationEffectiveChangeSchema'>, never>>;",
      "declare const reader: ConfigurationReader;",
      "reader.get([], { layer: 'base', defaultValue: null }); reader.snapshot(['literal.dot']); reader.withScope([]).forView('one');",
      "// @ts-expect-error only relative literal segment arrays are accepted",
      "reader.get('/alpha/flag');",
      "// @ts-expect-error captured readers never expose the controller",
      "reader.controller;",
      "// @ts-expect-error writers remain separate",
      "reader.apply([]);",
      "type ProjectionContract = Assert<Equal<z.output<typeof A4.registeredReadProjectionSchema>, { -readonly [K in keyof A4.RegisteredReadProjection]: A4.RegisteredReadProjection[K] }>>;",
      "declare const projection: A4.RegisteredReadProjection; declare const namespace: ConfigurationNamespace;",
      "projection.authorizeValidation(namespace, evidence => !evidence.sensitive); projection.get(namespace, evidence => evidence.path.length > 0);",
      "type SourcePath = Assert<Equal<z.output<typeof A3.resolutionOriginSchema>['sourcePath'], readonly string[] | undefined>>;",
      "type EffectiveSourcePath = Assert<Equal<z.output<typeof A3.resolvedPathInspectionSchema>['effectiveSourcePath'], readonly string[] | undefined>>;",
    );
    const fixture = join(directory, "proof.mts"); await writeFile(fixture, lines.join("\n"));
    const options = { strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: false, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: root, paths: { zod: ["packages/config-types/node_modules/zod"],
        "@weaver-conf/config-types": ["packages/config-types/src/index.ts"], "@weaver-conf/config-engine": ["packages/config-engine/src/index.ts"] } };
    const program = ts.createProgram([fixture], options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => "\n" }));
    const count = domains.reduce((total, [, , names]) => total + names.length, 0);
    console.log(`Actual443ab01 source: ${count} retained named domains, ${count * 2} input/output comparisons with explicit source-field/path migrations; retired families absent, canonical reader/lifecycle/projection contracts checked; strict types=[] skipLibCheck=false`);
    assert.match(await readFile(join(before, "packages/config-types/src/schemas-service-capabilities.ts"), "utf8"), /\.strictObject/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
