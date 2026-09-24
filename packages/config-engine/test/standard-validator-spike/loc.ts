import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const productionGroups = {
  ordinaryKeyword: [
    "schema-validation-cardinality.ts",
    "schema-validation-constraints.ts",
    "schema-validation-walk.ts",
  ],
  retainedPreflight: [
    "schema-validation-graph.ts",
    "schema-validation-composition.ts",
    "regex-cache.ts",
  ],
  retainedPaths: ["schema-validation-paths.ts"],
  retainedSupport: [
    "schema-validation-support.ts",
    "schema-validation-schemas.ts",
    "schema-validation.ts",
    "deep-equal.ts",
  ],
};
const spikeGroups = {
  adapterBaseline: ["adapters/baseline.ts"],
  adapterCfworker: ["adapters/cfworker.ts"],
  adapterAjvRuntime: ["adapters/ajv-runtime.ts"],
  adapterAjvStandalone: ["adapters/ajv-standalone.ts"],
  normalization: ["normalize.ts"],
  lowering: ["lower-schema.ts"],
  defaultsShadow: ["defaults-shadow.ts"],
  preflightWrapper: ["preflight.ts"],
};

const production = await countGroups(resolve(root, "src"), productionGroups);
const spike = await countGroups(import.meta.dirname, spikeGroups);
const baselineTotal = sum(Object.values(production));
const eliminable = production.ordinaryKeyword ?? 0;
const retained = baselineTotal - eliminable;
const sharedNew =
  (spike.normalization ?? 0) +
  (spike.lowering ?? 0) +
  (spike.defaultsShadow ?? 0) +
  (spike.preflightWrapper ?? 0);
const projections = Object.fromEntries(
  ["cfworker", "ajv-runtime", "ajv-standalone"].map((id) => {
    const adapter = awaitableAdapterLoc(id, spike);
    const projected = retained + sharedNew + adapter;
    return [
      id,
      {
        projectedProductionLoc: projected,
        netReductionLoc: baselineTotal - projected,
        reductionPercent: roundPercent(
          baselineTotal - projected,
          baselineTotal,
        ),
      },
    ];
  }),
);
const handwrittenFiles = await spikeFileList();
const handwrittenLoc = await countFiles(import.meta.dirname, handwrittenFiles);
const adapterMaximum = Math.max(
  spike.adapterCfworker ?? 0,
  spike.adapterAjvRuntime ?? 0,
  spike.adapterAjvStandalone ?? 0,
);
if (handwrittenFiles.length > 18 || handwrittenLoc > 2_600)
  throw new Error("Spike stop bound exceeded");
if (adapterMaximum > 250 || sharedNew > 500)
  throw new Error("Adapter/shared-layer LOC ceiling exceeded");
const artifact = {
  schemaVersion: 1,
  countingRule: "nonblank physical lines; comments retained",
  baseline: {
    groups: production,
    total: baselineTotal,
    eliminableOrdinaryKeyword: eliminable,
    retained,
  },
  spike: { groups: spike, sharedRetainedLayerTotal: sharedNew },
  projections,
  bounds: {
    handwrittenFiles: handwrittenFiles.length,
    handwrittenNonblankLoc: handwrittenLoc,
    investigate: { files: 18, loc: 2_550 },
    stop: { files: 18, loc: 2_600 },
    adapterCeiling: 250,
    sharedLayerCeiling: 500,
  },
};
await writeFile(
  resolve(import.meta.dirname, "results/loc.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
);
execFileSync(
  "pnpm",
  [
    "exec",
    "biome",
    "format",
    "--write",
    resolve(import.meta.dirname, "results/loc.json"),
  ],
  { stdio: "ignore" },
);

async function countGroups(
  base: string,
  groups: Readonly<Record<string, readonly string[]>>,
): Promise<Record<string, number>> {
  const entries = await Promise.all(
    Object.entries(groups).map(
      async ([name, files]) => [name, await countFiles(base, files)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

async function countFiles(
  base: string,
  files: readonly string[],
): Promise<number> {
  const texts = await Promise.all(
    files.map((file) => readFile(resolve(base, file), "utf8")),
  );
  return texts.reduce(
    (total, text) =>
      total + text.split("\n").filter((line) => line.trim().length > 0).length,
    0,
  );
}

async function spikeFileList(): Promise<readonly string[]> {
  return [
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
  ];
}

function awaitableAdapterLoc(
  id: string,
  spike: Record<string, number>,
): number {
  if (id === "cfworker") return spike.adapterCfworker ?? 0;
  if (id === "ajv-runtime") return spike.adapterAjvRuntime ?? 0;
  return spike.adapterAjvStandalone ?? 0;
}

function roundPercent(value: number, total: number): number {
  return Number(((value / total) * 100).toFixed(1));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

import { execFileSync } from "node:child_process";
