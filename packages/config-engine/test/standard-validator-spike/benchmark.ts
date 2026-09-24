import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MatrixArtifact } from "./types.js";

const matrix = JSON.parse(
  await readFile(resolve(import.meta.dirname, "results/matrix.json"), "utf8"),
) as MatrixArtifact;
const bundle = JSON.parse(
  await readFile(resolve(import.meta.dirname, "results/bundle.json"), "utf8"),
) as unknown;
const candidates = ["cfworker", "ajv-runtime", "ajv-standalone"] as const;
const skipped = Object.fromEntries(
  candidates.map((id) => {
    const summary = matrix.summary[id];
    return [
      id,
      {
        eligible: false,
        reason:
          summary.failures.length > 0
            ? `correctness/security hard-gate failures: ${summary.failures.join(", ")}`
            : "browser/CSP hard-gate failure",
      },
    ];
  }),
);
const artifact = {
  schemaVersion: 1,
  seed: 1_592_636_971,
  nodeFlags: [],
  configuration: {
    compile: { warmups: 20, samples: 100, freshEngine: true },
    hotSmallRepresentative: {
      warmupBatches: 5,
      samples: 30,
      operationsPerSample: 1_000,
    },
    hotLargeDepth: { warmupBatches: 5, samples: 30, operationsPerSample: 100 },
    adapterOrder: ["baseline", "cfworker", "ajv-runtime", "ajv-standalone"],
  },
  series: [],
  skipped,
  gatePolicy:
    "Performance is intentionally not measured after a correctness/security hard-gate failure.",
  bundleEvidenceLoaded: typeof bundle === "object" && bundle !== null,
};
await writeFile(
  resolve(import.meta.dirname, "results/benchmark.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
);
execFileSync(
  "pnpm",
  [
    "exec",
    "biome",
    "format",
    "--write",
    resolve(import.meta.dirname, "results/benchmark.json"),
  ],
  { stdio: "ignore" },
);

import { execFileSync } from "node:child_process";
