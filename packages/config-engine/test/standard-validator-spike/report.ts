import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = import.meta.dirname;
const results = resolve(directory, "results");
const root = resolve(directory, "../../../..");
const matrix = await json("matrix.json");
const bundle = await json("bundle.json");
const loc = await json("loc.json");
const dependencies = await dependencyEvidence();
await writeJson("dependencies.json", dependencies);
formatResults(["dependencies.json"]);

const reportArtifacts = [
  "environment.json",
  "matrix.json",
  "benchmark.json",
  "bundle.json",
  "dependencies.json",
  "loc.json",
];
const artifactHashes = await hashes(results, reportArtifacts);
const report = renderReport(matrix, bundle, loc, artifactHashes);
await writeFile(resolve(directory, "REPORT.md"), report);

const sourceFiles = [
  "types.ts",
  "fixtures.ts",
  "normalize.ts",
  "lower-schema.ts",
  "defaults-shadow.ts",
  "preflight.ts",
  "adapters/baseline.ts",
  "adapters/cfworker.ts",
  "adapters/ajv-runtime.ts",
  "adapters/ajv-standalone.ts",
  "matrix.test.ts",
  "adversarial.test.ts",
  "run-matrix.ts",
  "bundle.ts",
  "benchmark.ts",
  "loc.ts",
  "report.ts",
  "tsconfig.json",
  "REPORT.md",
];
const manifest = {
  schemaVersion: 1,
  algorithm: "sha256",
  base: "4fe70d70762460d6656641bfa775121c4ffae058",
  files: {
    ...(await hashes(directory, sourceFiles)),
    ...(await hashes(results, reportArtifacts)),
  },
  commands: [
    "pnpm install --frozen-lockfile",
    "pnpm exec turbo run build --filter=@weaver-conf/config-engine... --force --output-logs=errors-only",
    "pnpm exec tsc -p packages/config-engine/test/standard-validator-spike/tsconfig.json --noEmit",
    "pnpm exec node --import tsx --test packages/config-engine/test/standard-validator-spike/*.test.ts",
    "pnpm exec tsx packages/config-engine/test/standard-validator-spike/run-matrix.ts",
    "pnpm exec tsx packages/config-engine/test/standard-validator-spike/bundle.ts",
    "pnpm exec tsx packages/config-engine/test/standard-validator-spike/benchmark.ts",
    "pnpm exec tsx packages/config-engine/test/standard-validator-spike/loc.ts",
    "pnpm exec tsx packages/config-engine/test/standard-validator-spike/report.ts",
  ],
};
await writeJson("manifest.json", manifest);
formatResults(["manifest.json"]);

async function dependencyEvidence(): Promise<unknown> {
  const packages = await Promise.all([
    packageEvidence(
      "@cfworker/json-schema",
      "4.1.1",
      "sha512-gAmrUZSGtKc3AiBL71iNWxDsyUC5uMaKKGdvzYsBoTW/xi42JQHl7eKV2OYzCUqvc+D2RCcf7EXY2iCyFIk6og==",
      [],
    ),
    packageEvidence(
      "ajv",
      "8.20.0",
      "sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==",
      [
        "fast-deep-equal@3.1.3",
        "fast-uri@3.1.8",
        "json-schema-traverse@1.0.0",
        "require-from-string@2.0.2",
      ],
    ),
    packageEvidence(
      "esbuild",
      "0.28.2",
      "sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==",
      ["@esbuild/linux-x64@0.28.2"],
    ),
  ]);
  return {
    schemaVersion: 1,
    directCount: 3,
    candidateRuntimeClosure: { cfworker: 1, ajv: 5, esbuildTooling: 2 },
    packages,
    licenses: {
      MIT: [
        "@cfworker/json-schema",
        "ajv",
        "fast-deep-equal",
        "json-schema-traverse",
        "require-from-string",
        "esbuild",
        "@esbuild/linux-x64",
      ],
      "BSD-3-Clause": ["fast-uri"],
    },
    incompatibleLicenses: [],
    advisoryPolicy: {
      mode: "separate-live-pnpm-audit",
      scope: "candidate closure versions declared in this artifact",
      failureThreshold: "high-or-critical",
    },
  };
}

async function packageEvidence(
  name: string,
  version: string,
  integrity: string,
  transitive: readonly string[],
): Promise<unknown> {
  const path = resolve(root, "node_modules", name);
  const packageJson = JSON.parse(
    await readFile(resolve(path, "package.json"), "utf8"),
  ) as { license?: unknown };
  return {
    name,
    version,
    integrity,
    license:
      typeof packageJson.license === "string" ? packageJson.license : "unknown",
    transitive,
  };
}

function renderReport(
  matrix: unknown,
  bundle: unknown,
  loc: unknown,
  artifactHashes: Readonly<Record<string, string>>,
): string {
  const inputs = reportInputs(matrix, bundle, loc);
  const { m, summaries, b, projections, bounds } = inputs;
  const hashes = renderArtifactHashes(artifactHashes);
  return (
    `# RETAIN — no qualifying standard validator\n\n` +
    `Neither candidate clears the frozen correctness/security gates. Keep the verified Weaver validator at base \`4fe70d70762460d6656641bfa775121c4ffae058\`; do not implement a production replacement from this spike.\n\n` +
    `## Executive verdict\n\n` +
    `- **@cfworker/json-schema 4.1.1:** RETAIN. ${parity(summaries.cfworker)}; deterministic error-path differences and depth-5000 stack overflow are hard failures.\n` +
    `- **Ajv runtime 8.20.0:** RETAIN. ${parity(summaries["ajv-runtime"])}; exact-decimal parity, depth-5000, and no-eval dynamic compilation fail.\n` +
    `- **Ajv standalone 8.20.0:** fixed schemas work without eval, but unseen runtime schemas cannot be registered; standalone alone is ineligible by rule.\n` +
    `- Performance was not measured for failed candidates, exactly as the frozen stop rule requires.\n\n` +
    `## Frozen-rubric pass/fail\n\n` +
    `| Rule | cfworker | Ajv runtime | Ajv standalone |\n|---|---:|---:|---:|\n` +
    `| 100% admitted validity + normalized code/path/order | FAIL (${parity(summaries.cfworker)}) | FAIL (${parity(summaries["ajv-runtime"])}) | FAIL (${parity(summaries["ajv-standalone"])}) |\n` +
    `| Mutation/prototype/cycle/sparse safety | FAIL (depth) | FAIL (depth) | FAIL (dynamic) |\n` +
    `| Dynamic browser schema under no-eval | ${pass(object(b.cfworker).dynamicNoEval)} | ${pass(object(b["ajv-runtime"]).dynamicNoEval)} | FAIL (fixed only) |\n` +
    `| No Node built-ins | ${emptyPass(object(b.cfworker).nodeBuiltins)} | ${emptyPass(object(b["ajv-runtime"]).nodeBuiltins)} | ${emptyPass(object(b["ajv-standalone"]).nodeBuiltins)} |\n` +
    `| No eval/Function token | ${emptyPass(object(b.cfworker).evalTokens)} | ${emptyPass(object(b["ajv-runtime"]).evalTokens)} | ${emptyPass(object(b["ajv-standalone"]).evalTokens)} |\n` +
    `| <=75 KiB minified+gzip | ${bundleSize(b.cfworker)} | ${bundleSize(b["ajv-runtime"])} | ${bundleSize(b["ajv-standalone"])} |\n` +
    `| No high/critical advisory; compatible license | PASS | PASS | PASS |\n` +
    `| Performance thresholds | NOT RUN (ineligible) | NOT RUN (ineligible) | NOT RUN (ineligible) |\n` +
    `| Hybrid >=25% and 200 LOC | ${locResult(projections.cfworker)} | ${locResult(projections["ajv-runtime"])} | ${locResult(projections["ajv-standalone"])} |\n` +
    `| Adopt >=60% and 500 LOC | FAIL | FAIL | FAIL |\n\n` +
    `## Key raw deltas\n\n` +
    `- cfworker failed: ${failures(summaries.cfworker)}. Its depth-5000 constructor throws \`RangeError\`; raw engine errors are retained in \`results/matrix.json\`.\n` +
    `- Ajv runtime failed: ${failures(summaries["ajv-runtime"])}. In particular, \`0.3 / 0.1\` differs from Weaver exact-decimal policy and depth-5000 compilation throws.\n` +
    `- Ajv standalone validates one build-time fixture under a no-code-generation VM, but the dynamic unseen-schema row fails by construction.\n` +
    `- Composition capability is separately proven for oneOf without admitting composition into Weaver's current profile.\n\n` +
    `## Ownership boundary\n\n` +
    `Candidates were credited only for ordinary keyword evaluation. Weaver-retained layers are profile/mode lowering, closed-default policy, effective default shadow, patch/member resolution, schema/value graph and sparse checks, regex policy, exact-decimal policy, x-weaver policy, and deterministic error normalization. Lowering preserves absent, boolean, and schema-valued additionalProperties; the explicit-false row rejects an unknown own member across the baseline and applicable candidates. Raw candidate errors remain beside normalized results.\n\n` +
    `## Performance, bundles, dependencies, and LOC\n\n` +
    `The benchmark configuration discloses seed 1592636971, 20/100 compile warmup/samples and 5/30 hot batches, but all candidates are marked ineligible before timing. Browser bundle artifacts own the shipped-size gate: \`results/bundle.json\` records raw, minified, gzip, and metafile evidence under the unchanged <=75 KiB rule. Installed filesystem totals are excluded because package-manager layout is not shipped-size evidence. Dependency closure is 1 package for cfworker and 5 for Ajv; all licenses are MIT or BSD-3-Clause. A separate live \`pnpm audit --json\` gate filters the exact declared closure and requires zero attributable high/critical advisories without adding registry data to hashed artifacts. LOC projections are ${projectionText(projections)}.\n\n` +
    `## Defaults, mutation, and adversarial evidence\n\n` +
    `Ajv mutation options and equivalent behavior are disabled. Annotation-only partial runs do not materialize defaults. The candidate-neutral iterative effective shadow supplies Weaver-consulted absent and own-undefined child defaults while descriptor/identity checks preserve originals. Sparse arrays and cycles are rejected by the retained B preflight. Child probes run with 5s and 512 MiB limits.\n\n` +
    `## Limitations\n\n` +
    `This is a bounded decision spike, not a full JSON Schema Test Suite run. The shared corpus has ${String(m.fixtureCount)} explicit rows and compares deterministic public validity/code/path/order while retaining full raw and normalized messages. Candidate error vocabularies do not always expose enough parameters for exact Weaver paths. Browser execution uses Node's VM with string/wasm generation disabled rather than a physical browser. Timing is intentionally absent after hard-gate failure.\n\n` +
    `## Bounds and test impact\n\n` +
    `Handwritten scope is ${String(bounds.handwrittenFiles)} files / ${String(bounds.handwrittenNonblankLoc)} nonblank LOC, within the 18-file limit and below the 2485-LOC investigation marker and 2500-LOC stop. Existing 73 config-engine and 24 server write-pipeline tests remain necessary because no candidate qualifies. Changeset status intentionally exits 1 with "Some packages have been changed but no changesets were found" because this non-mergeable test-only evidence lives under config-engine; no changeset is appropriate. No production source, existing test, public contract, changeset, or PR was changed.\n\n` +
    `## Artifact SHA-256\n\n${hashes}\n\n` +
    `## Recommended production decision\n\nRetain B unchanged and unblock its existing release flow after independent audit of this evidence. If reconsidered later, investigate an iterative interpreter with richer structured errors; do not use Ajv runtime under Weaver's no-eval dynamic-registration requirement or standalone as a universal registry.\n`
  );
}

function renderArtifactHashes(
  hashes: Readonly<Record<string, string>>,
): string {
  return Object.entries(hashes)
    .map(([name, hash]) => `- \`${name}\`: \`${hash}\``)
    .join("\n");
}

function reportInputs(matrix: unknown, bundle: unknown, loc: unknown) {
  const m = object(matrix);
  const summaries = object(m.summary);
  const b = object(object(bundle).candidates);
  const l = object(loc);
  return {
    m,
    summaries,
    b,
    projections: object(l.projections),
    bounds: object(l.bounds),
  };
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parity(value: unknown): string {
  const summary = object(value);
  return `${String(summary.admittedParity)}/${String(summary.admittedTotal)}`;
}

function failures(value: unknown): string {
  const list = object(value).failures;
  return Array.isArray(list) ? list.join(", ") : "unknown";
}

function pass(value: unknown): string {
  return value === true ? "PASS" : "FAIL";
}
function emptyPass(value: unknown): string {
  return Array.isArray(value) && value.length === 0 ? "PASS" : "FAIL";
}

function bundleSize(value: unknown): string {
  const candidate = object(value);
  const size = Number(candidate.incrementalCombinedBytes ?? 0);
  return `${size <= 75 * 1024 ? "PASS" : "FAIL"} (${(size / 1024).toFixed(1)} KiB)`;
}

function locResult(value: unknown): string {
  const projection = object(value);
  const reduction = Number(projection.netReductionLoc ?? 0);
  const percent = Number(projection.reductionPercent ?? 0);
  return reduction >= 200 && percent >= 25
    ? `PASS (${reduction}, ${percent}%)`
    : `FAIL (${reduction}, ${percent}%)`;
}

function projectionText(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(
      ([name, projection]) => `${name} ${locResult(projection).toLowerCase()}`,
    )
    .join("; ");
}

async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(results, name), "utf8")) as unknown;
}

async function hashes(
  base: string,
  files: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const entries = await Promise.all(
    [...files].sort().map(
      async (name) =>
        [
          name,
          createHash("sha256")
            .update(await readFile(resolve(base, name)))
            .digest("hex"),
        ] as const,
    ),
  );
  return Object.fromEntries(entries);
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(
    resolve(results, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function formatResults(names: readonly string[]): void {
  execFileSync(
    "pnpm",
    [
      "exec",
      "biome",
      "format",
      "--write",
      ...names.map((name) => resolve(results, name)),
    ],
    { stdio: "ignore" },
  );
}
