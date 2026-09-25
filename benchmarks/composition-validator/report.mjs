import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) parsed[argv[index].slice(2)] = argv[++index];
  }
  return parsed;
}

function fixed(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function table(headers, rows) {
  const divider = headers.map(() => "---");
  return [`| ${headers.join(" | ")} |`, `| ${divider.join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function ratioVerdict(value, threshold) {
  return value <= threshold ? "PASS" : "FAIL";
}

function attemptText(attempt) {
  const state = attempt.stop ? `stopped: ${attempt.stop}` : attempt.disturbed ? "disturbed" : "complete";
  return `- Attempt ${attempt.index}: ${state}; ${attempt.results.length} child runs; load ${attempt.loadBefore.map((value) => fixed(value, 2)).join("/")} -> ${attempt.loadAfter.map((value) => fixed(value, 2)).join("/")}${attempt.disturbanceReasons.length > 0 ? `; ${attempt.disturbanceReasons.join("; ")}` : ""}`;
}

function ordinarySection(raw) {
  const gate = raw.gates.ordinary;
  const rows = gate.cases.map((item) => [item.id, fixed(item.baseP50), fixed(item.tipP50), fixed(item.p50Ratio), ratioVerdict(item.p50Ratio, raw.thresholds.ordinaryP50), fixed(item.p95Ratio), ratioVerdict(item.p95Ratio, raw.thresholds.ordinaryP95)]);
  const worstP50 = gate.cases.reduce((worst, item) => item.p50Ratio > worst.p50Ratio ? item : worst);
  const worstP95 = gate.cases.reduce((worst, item) => item.p95Ratio > worst.p95Ratio ? item : worst);
  return `## Ordinary base/tip gates\n\nP50 geomean: **${fixed(gate.geomean)}x** (${ratioVerdict(gate.geomean, raw.thresholds.ordinaryGeomean)}, limit 1.10). Worst p50: **${worstP50.id} ${fixed(worstP50.p50Ratio)}x**. Worst p95: **${worstP95.id} ${fixed(worstP95.p95Ratio)}x**. Times are ns/op.\n\n${table(["case", "base p50", "tip p50", "p50 ratio", "p50 gate", "p95 ratio", "p95 gate"], rows)}`;
}

function scalingSection(raw) {
  const rows = raw.gates.scaling.map((item) => [item.family, item.range, fixed(item.smallP50), fixed(item.largeP50), fixed(item.normalized), ratioVerdict(item.normalized, raw.thresholds.normalizedScaling)]);
  const worst = raw.gates.scaling.reduce((current, item) => item.normalized > current.normalized ? item : current);
  return `## Normalized scaling gates\n\nNormalized growth is elapsed growth divided by work-unit growth. Worst: **${worst.family} ${worst.range} ${fixed(worst.normalized)}x** (limit 1.50).\n\n${table(["family", "range", "small p50", "large p50", "normalized", "gate"], rows)}`;
}

function serverSection(raw) {
  const rows = raw.gates.server.map((item) => [item.id, fixed(item.p50), fixed(item.ordinaryP50), fixed(item.ratio), item.gated ? (item.ratio < raw.thresholds.server ? "PASS" : "FAIL") : "characterized"]);
  const gated = raw.gates.server.filter((item) => item.gated);
  const worst = gated.reduce((current, item) => item.ratio > current.ratio ? item : current);
  return `## Server full-candidate gates\n\nWorst gated two-branch ratio: **${worst.id} ${fixed(worst.ratio)}x** (strict limit <2.0). not/shared-40 are safety-characterized only.\n\n${table(["case", "p50", "ordinary p50", "ratio", "gate"], rows)}`;
}

function variabilitySection(raw) {
  const values = Object.values(raw.gates.aggregates);
  const rows = values.map((item) => [item.id, item.variant, item.runP95.map((value) => fixed(value)).join(", "), item.cv.map((value) => fixed(value * 100, 2)).join(", "), item.drift.map((value) => fixed(value * 100, 2)).join(", "), `${(item.maxRss / 1024 ** 2).toFixed(1)} MiB`]);
  const maxCv = Math.max(...values.flatMap((item) => item.cv));
  const maxDrift = Math.max(...values.flatMap((item) => item.drift.map(Math.abs)));
  const maxRss = Math.max(...values.map((item) => item.maxRss));
  return `## Variability and memory context\n\nCV and drift are informational. Maximum CV: **${fixed(maxCv * 100, 2)}%**; maximum absolute first-five/last-five drift: **${fixed(maxDrift * 100, 2)}%**; maximum observed RSS: **${(maxRss / 1024 ** 2).toFixed(1)} MiB** (hard limit 1024 MiB).\n\n${table(["case", "source", "run p95 ns/op", "run CV %", "run drift %", "max RSS"], rows)}`;
}

function evidenceSection(raw, rawHash) {
  const build = raw.buildEvidence.recorded === false
    ? raw.buildEvidence.reason
    : Object.entries(raw.buildEvidence.durationsMs ?? {}).map(([key, value]) => `${key}=${value}ms`).join(", ");
  return `## Reproducibility evidence\n\n- Base: \`${raw.sources.base.sha}\` (tree \`${raw.sources.base.tree}\`, packages \`${raw.sources.base.packagesTree}\`, lock \`${raw.sources.base.lockHash}\`, clean: ${raw.sources.base.clean})\n- Tip: \`${raw.sources.tip.sha}\` (tree \`${raw.sources.tip.tree}\`, packages \`${raw.sources.tip.packagesTree}\`, lock \`${raw.sources.tip.lockHash}\`, clean: ${raw.sources.tip.clean})\n- Seed/core: \`${raw.seed}\` / CPU ${raw.environment.cpu.selectedCore}; child affinity is recorded per run\n- Host: ${raw.environment.cpu.model}; ${raw.environment.platform}/${raw.environment.arch}; kernel ${raw.environment.kernel}; Node ${raw.environment.node}; V8 ${raw.environment.v8}\n- Preflight: ${raw.preflight.descriptorCount} descriptors / ${raw.preflight.recordCount} records; hash \`${raw.preflight.recordsHash}\`; passed: ${raw.preflight.passed}\n- Timed matrix: ${raw.timedDescriptorCount} descriptors / ${raw.timedSourceCaseCount} source cases / ${raw.childRunCount} child runs / ${raw.sampleCount} samples\n- Build durations: ${build}\n- Fixture manifest SHA-256: \`${raw.fixtureManifestHash}\`\n- Raw JSON SHA-256: \`${rawHash}\``;
}

function methodSection(raw) {
  const attempts = raw.attempts.map(attemptText).join("\n");
  return `## Method and attempts\n\nOne child per source case/run, all sequential on fixed non-CPU0 CPU ${raw.methodology.core}. Every complete child records ${raw.methodology.samplesPerRun} samples after bounded calibration and at least ${raw.methodology.warmupMinimum.batches} final-shape batches / ${raw.methodology.warmupMinimum.milliseconds} ms warmup. Setup, correctness, calibration, warmup, hashing, and report generation are untimed. No individual run was retried or trimmed.\n\n${attempts}`;
}

function render(raw, rawText) {
  const rawHash = createHash("sha256").update(rawText).digest("hex");
  const reasonText = raw.reasons.length === 0 ? "All hard correctness/safety and numeric gates passed." : raw.reasons.map((reason) => `- ${reason}`).join("\n");
  const sections = [`# Composition validator replacement benchmark report\n\n## Verdict: ${raw.verdict}\n\n${reasonText}`, evidenceSection(raw, rawHash), methodSection(raw)];
  if (raw.gates !== null) sections.push(ordinarySection(raw), scalingSection(raw), serverSection(raw), variabilitySection(raw));
  sections.push("## Correctness and limitations\n\nAll preflight and child probes use built public exports and check declared validity/error shape, server write/notification/revision effects, prototypes, and input/schema fingerprints. Memory is observational RSS/heap sampling, not allocation measurement. CV/drift are disclosed above but do not alter the verdict.");
  return `${sections.join("\n\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = resolve(args.input ?? "benchmarks/composition-validator/results/raw.json");
  const output = resolve(args.output ?? "benchmarks/composition-validator/REPORT.md");
  const rawText = await readFile(input, "utf8");
  const raw = JSON.parse(rawText);
  if (!["PASS", "FAIL"].includes(raw.verdict)) throw new Error(`unsupported verdict ${raw.verdict}`);
  if (raw.verdict === "PASS" && (raw.reasons.length > 0 || raw.gates?.failures.length > 0)) throw new Error("raw PASS contradicts recorded failures");
  await writeFile(output, render(raw, rawText));
  process.stdout.write(`${raw.verdict}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
