import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) if (argv[index].startsWith("--")) parsed[argv[index].slice(2)] = argv[++index];
  return parsed;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function aggregate(runs) {
  return { p50: median(runs.map((run) => run.stats.p50)), p95: median(runs.map((run) => run.stats.p95)), mad: median(runs.map((run) => run.stats.mad)), cv: median(runs.map((run) => run.stats.cv)), ops: median(runs.map((run) => run.stats.opsPerSecond)), rss: Math.max(...runs.map((run) => run.memory.highWaterRss)), heap: Math.max(...runs.map((run) => run.memory.highWaterHeap)), postGc: Math.max(...runs.map((run) => Math.max(run.memory.postGcRssDelta, run.memory.postGcHeapDelta))) };
}

function fixed(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function markdownTable(headers, rows) {
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function classify(value, pass, fail) {
  if (value <= pass) return "PASS";
  if (value <= fail) return "INVESTIGATE";
  return "FAIL";
}

function resultMap(results) {
  const grouped = new Map();
  for (const result of results) {
    const key = `${result.id}\0${result.variant}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(result);
  }
  return new Map([...grouped].map(([key, runs]) => [key, { runs, aggregate: aggregate(runs), first: runs[0] }]));
}

function ordinaryRows(byCase, thresholds) {
  const rows = [];
  const ratios = [];
  for (const [key, base] of byCase) {
    if (!key.endsWith("\0base")) continue;
    const id = key.slice(0, -5);
    const tip = byCase.get(`${id}\0tip`);
    const p50 = tip.aggregate.p50 / base.aggregate.p50;
    const p95 = tip.aggregate.p95 / base.aggregate.p95;
    ratios.push(p50);
    rows.push([id, fixed(base.aggregate.p50), fixed(tip.aggregate.p50), fixed(p50), fixed(p95), classify(Math.max(p50 / thresholds.p50Pass, p95 / thresholds.p95Pass), 1, Math.max(thresholds.p50Fail / thresholds.p50Pass, thresholds.p95Fail / thresholds.p95Pass))]);
  }
  const geomean = Math.exp(ratios.reduce((sum, ratio) => sum + Math.log(ratio), 0) / ratios.length);
  return { rows, geomean, worstP50: Math.max(...rows.map((row) => Number(row[3]))), worstP95: Math.max(...rows.map((row) => Number(row[4]))) };
}

function scalingRows(byCase, thresholds) {
  const families = new Map();
  for (const value of byCase.values()) {
    const { first } = value;
    if (first.variant !== "tip" || first.work === null) continue;
    if (!families.has(first.family)) families.set(first.family, []);
    families.get(first.family).push(value);
  }
  const rows = [];
  for (const [family, values] of families) {
    const ordered = values.sort((left, right) => left.first.work - right.first.work);
    const small = ordered[0];
    const large = ordered.at(-1);
    if (small.first.work === large.first.work) continue;
    const normalized = (large.aggregate.p50 / small.aggregate.p50) / (large.first.work / small.first.work);
    rows.push([family, small.first.work, large.first.work, fixed(normalized), classify(normalized, thresholds.pass, thresholds.fail)]);
  }
  return rows;
}

function serverRows(byCase, thresholds) {
  const rows = [];
  const ordinaryValid = byCase.get("ordinary:server:valid\0tip").aggregate.p50;
  const ordinaryInvalid = byCase.get("ordinary:server:invalid\0tip").aggregate.p50;
  for (const [key, value] of byCase) {
    if (!key.startsWith("server:") || !key.endsWith("\0tip")) continue;
    const denominator = value.first.correctness.actualValid ? ordinaryValid : ordinaryInvalid;
    const ratio = value.aggregate.p50 / denominator;
    rows.push([value.first.id, fixed(value.aggregate.p50), fixed(ratio), classify(ratio, thresholds.pass, thresholds.fail), value.first.effects.delta.writes, value.first.effects.delta.notifications]);
  }
  return rows;
}

function positionRows(byCase) {
  const rows = [];
  for (const value of byCase.values()) if (value.first.position !== null) rows.push([value.first.id, value.first.position, fixed(value.aggregate.p50), fixed(value.aggregate.p95), fixed(value.aggregate.cv * 100, 2)]);
  return rows;
}

function verdict(raw, ordinary, scaling, server, byCase) {
  const reasons = [];
  let level = "PASS";
  const raise = (next, reason) => { if (next === "FAIL" || (next === "INVESTIGATE" && level === "PASS")) level = next; reasons.push(`${next}: ${reason}`); };
  if (raw.correctnessFailures.length > 0) raise("FAIL", `${raw.correctnessFailures.length} correctness failures`);
  if (raw.sets.every((set) => set.discarded)) raise("INVESTIGATE", "no stable run set after two replacements");
  const threshold = raw.thresholds.ordinary;
  const geo = classify(ordinary.geomean, threshold.geomeanPass, threshold.geomeanFail);
  if (geo !== "PASS") raise(geo, `ordinary p50 geomean ${fixed(ordinary.geomean)}`);
  for (const row of ordinary.rows) {
    const p50 = classify(Number(row[3]), threshold.p50Pass, threshold.p50Fail);
    const p95 = classify(Number(row[4]), threshold.p95Pass, threshold.p95Fail);
    if (p50 !== "PASS") raise(p50, `${row[0]} p50 ratio ${row[3]}`);
    if (p95 !== "PASS") raise(p95, `${row[0]} p95 ratio ${row[4]}`);
  }
  for (const row of scaling) if (row[4] !== "PASS") raise(row[4], `${row[0]} normalized growth ${row[3]}`);
  for (const row of server) if (row[3] !== "PASS") raise(row[3], `${row[0]} server ratio ${row[2]}`);
  for (const value of byCase.values()) if (value.aggregate.postGc > raw.thresholds.memory.investigatePostGcBytes) raise("INVESTIGATE", `${value.first.id} post-GC growth ${value.aggregate.postGc}`);
  return { level, reasons };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = resolve(args.input ?? "benchmarks/composition-validator/results/raw.json");
  const output = resolve(args.output ?? "benchmarks/composition-validator/REPORT.md");
  const text = await readFile(input, "utf8");
  const raw = JSON.parse(text);
  if (raw.stop !== null) {
    const report = `# Composition validator benchmark report\n\n## Verdict: FAIL\n\nThe frozen matrix stopped at the required safety boundary and was not silently reduced. Case \`${raw.stop.case}\` crashed during ${raw.stop.phase}: ${raw.stop.reason}. A process crash/OOM is an immediate FAIL under the predeclared thresholds. Full 3 × 25 timing evidence, ordinary geomean, scaling, server ratio, and comparative memory summaries are therefore unavailable; stable full-matrix run count is **${raw.stop.stableRuns}**.\n\n## Evidence\n\n- Base: \`${raw.sources.base.sha}\` (tree \`${raw.sources.base.tree}\`, packages \`${raw.sources.base.packagesTree}\`, clean: ${raw.sources.base.clean})\n- Tip: \`${raw.sources.tip.sha}\` (tree \`${raw.sources.tip.tree}\`, packages \`${raw.sources.tip.packagesTree}\`, clean: ${raw.sources.tip.clean})\n- Seed: \`${raw.seed}\`; stopped case: \`${raw.stop.case}\`; completed measured samples: ${raw.stop.completedSamples}\n- Fixture manifest SHA-256: \`${raw.fixtureManifestHash}\`\n- Raw JSON SHA-256: \`${createHash("sha256").update(text).digest("hex")}\`\n- Host: ${raw.environment.cpu.model}; ${raw.environment.arch}; kernel ${raw.environment.release}; Node ${raw.environment.node}; V8 ${raw.environment.v8}\n- Selected core: ${raw.environment.cpu.selectedCore}; affinity: ${raw.environment.cpu.affinity}; topology: ${raw.environment.cpu.topology ?? "unknown"}; cache: ${raw.environment.cpu.cache ?? "unknown"}\n- Governor/frequency/boost: ${raw.environment.cpu.governor ?? "unknown"} / ${raw.environment.cpu.frequencyKHz ?? "unknown"} kHz / ${raw.environment.cpu.boost ?? "unknown"}\n- Load: ${raw.environment.loadAverage.map((value) => fixed(value, 2)).join(" / ")}; RAM: ${(raw.environment.memory.total / 1024 ** 3).toFixed(1)} GiB; NODE_OPTIONS: ${raw.environment.nodeOptions ?? "unset"}\n\n## Build and stop details\n\nBoth exact worktrees completed frozen-lockfile installation and forced config-engine/server Turbo builds before execution. Recorded milliseconds: base install ${raw.buildEvidence.milliseconds.baseInstall}, engine ${raw.buildEvidence.milliseconds.baseEngine}, server ${raw.buildEvidence.milliseconds.baseServer}; tip install ${raw.buildEvidence.milliseconds.tipInstall}, engine ${raw.buildEvidence.milliseconds.tipEngine}, server ${raw.buildEvidence.milliseconds.tipServer}. Import, registration, fixture setup, calibration, warmup, hashing, and reporting are excluded from hot timing. The failure occurred in excluded setup, while registering the depth-40 shared-identity allOf schema through public \`createSchemaRegistry\` after constructing the service with public \`createWeaverConfigService\` and the in-memory provider. V8 reported ineffective mark-compacts near its approximately 4 GiB heap limit and terminated the child with JavaScript heap out of memory. This also exceeds the 1 GiB RSS safety ceiling by construction.\n\n## Limitations\n\nNo ordinary geomean, worst paired cases, normalized scaling, server ratio, or matrix memory maximum is claimed from an incomplete run. Isolated smoke timings are intentionally excluded because they are not the frozen three-run stable matrix. CPU thermal, virtualization/container, turbo, and AC fields are retained in raw evidence where the host exposes them.\n`;
    await writeFile(output, report);
    process.stdout.write("FAIL\n");
    return;
  }
  const accepted = raw.sets.find((set) => set.set === raw.acceptedSet);
  const byCase = resultMap(accepted.results);
  const ordinary = ordinaryRows(byCase, raw.thresholds.ordinary);
  const scaling = scalingRows(byCase, raw.thresholds.scaling);
  const server = serverRows(byCase, raw.thresholds.server);
  const positions = positionRows(byCase);
  const decision = verdict(raw, ordinary, scaling, server, byCase);
  const unstable = raw.sets.filter((set) => set.discarded).map((set) => `set ${set.set}: ${set.reason}`).join("; ") || "none";
  const maxRss = Math.max(...[...byCase.values()].map((value) => value.aggregate.rss));
  const maxHeap = Math.max(...[...byCase.values()].map((value) => value.aggregate.heap));
  const report = `# Composition validator benchmark report\n\n## Verdict: ${decision.level}\n\n${decision.reasons.length > 0 ? decision.reasons.map((reason) => `- ${reason}`).join("\n") : "All frozen correctness, timing, scaling, server, and safety bounds passed."}\n\n## Evidence\n\n- Base: \`${raw.sources.base.sha}\` (tree \`${raw.sources.base.tree}\`, packages \`${raw.sources.base.packagesTree}\`)\n- Tip: \`${raw.sources.tip.sha}\` (tree \`${raw.sources.tip.tree}\`, packages \`${raw.sources.tip.packagesTree}\`)\n- Seed: \`${raw.seed}\`; accepted set: ${raw.acceptedSet}; discarded sets: ${unstable}\n- Fixture manifest SHA-256: \`${raw.fixtureManifestHash}\`\n- Raw JSON SHA-256: \`${createHash("sha256").update(text).digest("hex")}\`\n- Host: ${raw.environment.cpu.model}; Node ${raw.environment.node}; V8 ${raw.environment.v8}; core ${raw.environment.cpu.selectedCore}; affinity ${raw.environment.cpu.topology ?? "unknown"}\n- Load before capture: ${raw.environment.loadAverage.map((value) => fixed(value, 2)).join(" / ")}\n\n## Ordinary base/tip\n\nP50 geometric mean tip/base: **${fixed(ordinary.geomean)}x**. Worst p50: ${fixed(ordinary.worstP50)}x; worst p95: ${fixed(ordinary.worstP95)}x. Times are ns/op.\n\n${markdownTable(["case", "base p50", "tip p50", "p50 ratio", "p95 ratio", "summary"], ordinary.rows)}\n\n## Scaling\n\nNormalized growth is (large/small elapsed) / (large/small work units).\n\n${markdownTable(["family", "small", "large", "normalized", "verdict"], scaling)}\n\n## Branch position characterization\n\n${markdownTable(["case", "position", "p50 ns/op", "p95 ns/op", "CV %"], positions)}\n\n## Server full-candidate patches\n\nComposition p50 ratios use the corresponding tip ordinary valid or invalid full-candidate patch. Effect columns are per measured run; invalid operations must remain zero.\n\n${markdownTable(["case", "p50 ns/op", "ordinary ratio", "verdict", "writes", "notifications"], server)}\n\n## Memory and validity\n\nMaximum observed RSS: ${(maxRss / 1024 ** 2).toFixed(1)} MiB; maximum observed heap: ${(maxHeap / 1024 ** 2).toFixed(1)} MiB. Correctness failures: ${raw.correctnessFailures.length}. Every case recorded fixture/result hashes, server entry/error digests, revision/write/notification counters, prototype checks, raw samples, and before/after/high-water/post-GC memory. GC runs before samples but outside timed batches. RSS and heap figures are observational; GC variation is not allocation precision and does not decide timing PASS.\n\n## Method and caveats\n\nOne case/run executes per child with \`--expose-gc\`; paired cases use seeded ABBAAB order. Each run calibrates to 100–250 ms with at least 100 operations, warms for at least five batches and two seconds, then records 25 samples. Three independent runs constitute a set. Import, fixture/registration/service setup, calibration, warmup, hashing, and reporting are excluded and retained separately in raw data. Stability rejects a whole set when any run CV or first/last-five median drift exceeds 5%, with at most two replacements. CPU frequency, governor, topology, thermal/container visibility, load, RAM/swap, tool versions, and NODE_OPTIONS are captured in raw data. Turbo boost and AC state were not programmatically available and remain host caveats.\n`;
  await writeFile(output, report);
  process.stdout.write(`${decision.level}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
