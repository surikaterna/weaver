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
  ["config-types", "schemas-service-capabilities", ["configurationServiceIdentitySchema", "configurationInspectionValueSchema", "configurationLayerContributionSchema", "hydratedConfigurationInspectionSchema", "configurationEffectiveChangeSchema", "configurationServiceWriteOptionsSchema", "configurationServiceWriteResultSchema", "hydratedConfigurationReaderSchema", "hydratedConfigurationServiceSchema", "hydratedScopedConfigurationServiceSchema", "hydratedServiceConfigurationServiceSchema"]],
  ["config-engine", "snapshot-contracts", ["resolutionPathSchema", "resolutionOriginSchema", "resolutionLayerSchema", "resolutionCeilingSchema", "resolutionSnapshotInputSchema", "resolutionContributionSchema", "configurationSnapshotSchema", "resolvedPathInspectionSchema"]],
  ["config-registry", "registered-read-contracts", ["registeredReadProjectionContextSchema", "registeredReadProjectionSchema"]],
  ["config-engine", "registration-paths", ["canonicalConfigPathSchema"]],
];

test("native contracts restore pinned schema input/output types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weaver-domain-types-"));
  try {
    const before = join(directory, "before"); await mkdir(before);
    const archive = execFileSync("git", ["archive", "443ab01efb4c8f8226ab797e56655ba85e255593",
      "packages/config-types/src", "packages/config-engine/src", "packages/config-registry/src"], { cwd: root });
    const tar = join(directory, "before.tar"); await writeFile(tar, archive);
    execFileSync("tar", ["-xf", tar, "-C", before]);
    const lines = ["import type { z } from 'zod';", "type Normalize<T> = T extends (...args: never[])=>unknown ? T : T extends object ? { [K in keyof T]: Normalize<T[K]> } : T;",
      "type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;", "type Assert<T extends true> = T;"];
    domains.forEach(([pkg, module, names], index) => {
      lines.push(`import * as B${index} from '${join(before, "packages", pkg, "src", module)}';`);
      lines.push(`import * as A${index} from '${join(root, "packages", pkg, "src", module)}';`);
      for (const name of names) {
        for (const direction of ["input", "output"]) {
          const b = `z.${direction}<typeof B${index}.${name}>`, a = `z.${direction}<typeof A${index}.${name}>`;
          lines.push(`type ${name}_${direction}_forward = Assert<[${b}] extends [${a}] ? true : false>;`);
          lines.push(`type ${name}_${direction}_reverse = Assert<[${a}] extends [${b}] ? true : false>;`);
          if (!name.startsWith("hydrated") || name === "hydratedConfigurationInspectionSchema")
            lines.push(`type ${name}_${direction} = Assert<Equal<Normalize<${b}>,Normalize<${a}>>>;`);
        }
      }
    });
    lines.push(
      "A0.serviceIdSchema.min(2); A0.providerIdSchema.regex(/panel/);",
      "A1.relativeConfigurationPathSchema.out.unwrap().rest(A0.providerIdSchema);",
      "A2.configurationServiceIdentitySchema.out.unwrap().pick({ environment: true });",
      "A2.configurationServiceIdentitySchema.out.unwrap().omit({ scopePath: true });",
      "A2.configurationServiceIdentitySchema.out.unwrap().extend({ revision: A2.hydratedConfigurationReaderSchema.out.shape.revision });",
      "A3.resolutionOriginSchema.out.unwrap().shape.rank.finite();",
      "A4.registeredReadProjectionSchema.out.pick({ entries: true });",
      "A4.registeredReadProjectionContextSchema.out.unwrap().shape.revision.min(1);",
      "A5.canonicalConfigPathSchema.out.unwrap().shape.storageKey.min(1);",
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
    console.log("Actual443ab01 source: 29 named schema domains, 58 input/output equivalence checks, strict types=[] skipLibCheck=false");
    assert.match(await readFile(join(before, "packages/config-types/src/schemas-service-capabilities.ts"), "utf8"), /\.strictObject/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
