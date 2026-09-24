import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { schemaValidationResultSchema } from "../../src/schema-validation-schemas.js";
import { createAjvRuntimeAdapter } from "./adapters/ajv-runtime.js";
import { createAjvStandaloneAdapter } from "./adapters/ajv-standalone.js";
import { createBaselineAdapter } from "./adapters/baseline.js";
import { createCfworkerAdapter } from "./adapters/cfworker.js";
import { fixtures } from "./fixtures.js";
import { comparableResult } from "./normalize.js";
import type {
  AdapterId,
  AdapterSummary,
  MatrixArtifact,
  MatrixCell,
  MatrixRow,
  ValidationObservation,
  ValidatorAdapter,
} from "./types.js";

const root = resolve(import.meta.dirname, "../../../..");
const resultsDirectory = resolve(import.meta.dirname, "results");

export async function buildMatrix(): Promise<MatrixArtifact> {
  const adapters = createAdapters();
  const rows = fixtures.map((fixture) => runFixture(fixture, adapters));
  rows.push(runDynamicFixture(adapters));
  const summary = Object.fromEntries(
    adapters.map((adapter) => [adapter.id, summarize(adapter.id, rows)]),
  );
  return {
    schemaVersion: 1,
    fixtureCount: rows.length,
    deterministicRuns: 100,
    rows,
    summary: summary as Readonly<Record<AdapterId, AdapterSummary>>,
  };
}

function runFixture(
  fixture: (typeof fixtures)[number],
  adapters: readonly ValidatorAdapter[],
): MatrixRow {
  const baseline = adapters[0];
  if (baseline === undefined) throw new Error("Baseline adapter missing");
  const expected = observeFixture(baseline, fixture).normalized;
  assertFixtureExpectation(fixture, expected);
  schemaValidationResultSchema.parse(expected);
  const actual = adapters.map((adapter) => cell(adapter, fixture, expected));
  return {
    id: fixture.id,
    category: fixture.category,
    admitted: fixture.admitted !== false,
    expected,
    owner:
      fixture.category === "composition"
        ? "weaver-profile-admission"
        : ownership(fixture.category),
    actual,
  };
}

function cell(
  adapter: ValidatorAdapter,
  fixture: (typeof fixtures)[number],
  expected: MatrixRow["expected"],
): MatrixCell {
  const observation = observeFixture(adapter, fixture);
  schemaValidationResultSchema.parse(observation.normalized);
  const parity =
    comparableResult(observation.normalized) === comparableResult(expected);
  if (!expected.valid)
    assertDeterministic(adapter, fixture, observation.normalized);
  return {
    adapter: adapter.id,
    valid: observation.normalized.valid,
    normalizedParity: parity,
    raw: stableRaw(observation.raw),
    normalized: observation.normalized,
    compileMs: 0,
    elapsedMs: 0,
    ...(observation.threw === undefined ? {} : { threw: observation.threw }),
  };
}

function observeFixture(
  adapter: ValidatorAdapter,
  fixture: (typeof fixtures)[number],
): ValidationObservation {
  if (fixture.patch !== undefined) {
    return adapter.validatePatch(
      fixture.schema,
      fixture.patch.path,
      fixture.value,
      fixture.patch.options,
    );
  }
  return adapter
    .compile(fixture.schema, fixture.mode ?? "partial")
    .validate(fixture.value);
}

function assertDeterministic(
  adapter: ValidatorAdapter,
  fixture: (typeof fixtures)[number],
  first: MatrixRow["expected"],
): void {
  const encoded = comparableResult(first);
  for (let index = 1; index < 100; index++) {
    if (
      comparableResult(observeFixture(adapter, fixture).normalized) !== encoded
    ) {
      throw new Error(
        `${adapter.id}/${fixture.id} produced nondeterministic normalized output`,
      );
    }
  }
}

function runDynamicFixture(adapters: readonly ValidatorAdapter[]): MatrixRow {
  const schema = {
    type: "object",
    required: ["fresh"],
    properties: { fresh: { type: "integer" } },
  } as const;
  const expected = { valid: true, errors: [] } as const;
  const actual = adapters.map((adapter): MatrixCell => {
    adapter.reset();
    adapter.register("unseen-runtime", schema);
    const observation = adapter.validateRegistered(
      "unseen-runtime",
      { fresh: 1 },
      "effective",
    );
    return {
      adapter: adapter.id,
      valid: observation.normalized.valid,
      normalizedParity: observation.normalized.valid,
      raw: stableRaw(observation.raw),
      normalized: observation.normalized,
      compileMs: 0,
      elapsedMs: 0,
      ...(observation.threw === undefined ? {} : { threw: observation.threw }),
    };
  });
  return {
    id: "dynamic-unseen-schema",
    category: "dynamic-registration",
    admitted: true,
    expected,
    owner: "engine",
    actual,
  };
}

function summarize(id: AdapterId, rows: readonly MatrixRow[]): AdapterSummary {
  const cells = rows
    .map((row) => ({
      row,
      cell: row.actual.find((cell) => cell.adapter === id),
    }))
    .filter((entry) => entry.cell !== undefined);
  const admitted = cells.filter(({ row }) => row.admitted);
  const failures = admitted
    .filter(
      ({ cell }) => cell?.normalizedParity !== true || cell.threw !== undefined,
    )
    .map(({ row }) => row.id);
  return {
    total: cells.length,
    parity: cells.filter(({ cell }) => cell?.normalizedParity === true).length,
    admittedTotal: admitted.length,
    admittedParity: admitted.filter(
      ({ cell }) => cell?.normalizedParity === true,
    ).length,
    throws: cells.filter(({ cell }) => cell?.threw !== undefined).length,
    eligible: id === "baseline" || failures.length === 0,
    failures,
  };
}

function createAdapters(): readonly ValidatorAdapter[] {
  return [
    createBaselineAdapter(),
    createCfworkerAdapter(),
    createAjvRuntimeAdapter(),
    createAjvStandaloneAdapter(),
  ];
}

function assertFixtureExpectation(
  fixture: (typeof fixtures)[number],
  result: MatrixRow["expected"],
): void {
  if (result.valid !== fixture.expectedValid)
    throw new Error(`Baseline validity drift for ${fixture.id}`);
  if (fixture.expectedFirst === undefined) return;
  const first = result.errors[0];
  if (
    first?.code !== fixture.expectedFirst.code ||
    first.path !== fixture.expectedFirst.path
  ) {
    throw new Error(
      `Baseline error drift for ${fixture.id}: ${JSON.stringify(first)}`,
    );
  }
}

function ownership(category: string): string {
  if (
    ["defaults", "patch", "graph-safety", "prototype-safety"].includes(category)
  )
    return "weaver-retained-policy";
  return "candidate-ordinary-keyword";
}

function stableRaw(raw: readonly unknown[]): readonly unknown[] {
  return raw.map((item) => JSON.parse(JSON.stringify(item)) as unknown);
}

async function writeArtifacts(matrix: MatrixArtifact): Promise<void> {
  const lock = await BunlessFile(resolve(root, "pnpm-lock.yaml"));
  const environment = {
    schemaVersion: 1,
    base: "4fe70d70762460d6656641bfa775121c4ffae058",
    branch: "feature/standard-validator-spike",
    node: process.version,
    pnpm: "11.13.0",
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    lockfileSha256: createHash("sha256").update(lock).digest("hex"),
    packages: {
      "@cfworker/json-schema": "4.1.1",
      ajv: "8.20.0",
      esbuild: "0.28.2",
    },
    integrities: {
      "@cfworker/json-schema":
        "sha512-gAmrUZSGtKc3AiBL71iNWxDsyUC5uMaKKGdvzYsBoTW/xi42JQHl7eKV2OYzCUqvc+D2RCcf7EXY2iCyFIk6og==",
      ajv: "sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==",
      esbuild:
        "sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==",
    },
  };
  await writeJson("environment.json", environment);
  await writeJson("matrix.json", matrix);
  formatResults(["environment.json", "matrix.json"]);
}

async function BunlessFile(path: string): Promise<string> {
  return import("node:fs/promises").then(({ readFile }) =>
    readFile(path, "utf8"),
  );
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(
    resolve(resultsDirectory, name),
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
      ...names.map((name) => resolve(resultsDirectory, name)),
    ],
    { stdio: "ignore" },
  );
}

if (process.argv[2] === "--probe") {
  const adapter = createAdapters().find((item) => item.id === process.argv[3]);
  const fixture = fixtures.find((item) => item.id === process.argv[4]);
  if (adapter === undefined || fixture === undefined)
    throw new Error("Unknown probe target");
  process.stdout.write(
    `${JSON.stringify(observeFixture(adapter, fixture).normalized)}\n`,
  );
} else if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  await writeArtifacts(await buildMatrix());
}
