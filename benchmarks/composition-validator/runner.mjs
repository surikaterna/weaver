import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, loadavg, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildFixture, caseDescriptors, fingerprint, SEED } from "./fixtures.mjs";
const EXPECTED = { base: "4fe70d70762460d6656641bfa775121c4ffae058", tip: "e2e79332572261ec526475f40f2ebf08a7f17cdd" };
const SAMPLE_COUNT = 25;
const RUN_COUNT = 3;
const here = dirname(fileURLToPath(import.meta.url));
function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const next = argv[index + 1];
    parsed[argv[index].slice(2)] = next && !next.startsWith("--") ? argv[++index] : true;
  }
  return parsed;
}
function stable(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function digest(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
function statistics(samples) {
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  const first = percentile(samples.slice(0, 5), 0.5);
  const last = percentile(samples.slice(-5), 0.5);
  return { p50, p95, cv: Math.sqrt(variance) / mean, drift: (last - first) / first };
}
async function invokeBatch(fixture, operations) {
  let result;
  for (let index = 0; index < operations; index += 1) {
    result = fixture.async ? await fixture.operation() : fixture.operation();
  }
  return result;
}
function errorList(descriptor, result) { return descriptor.kind === "server" ? result?.error?.details?.errors : result?.errors; }
function effectDelta(before, after) {
  return Object.fromEntries(
    ["writes", "notifications", "revisions"].map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]),
  );
}
function checkProbe(descriptor, result, fixtureBefore, fixtureAfter, before, after) {
  const actualValid = descriptor.kind === "server" ? result?.success === true : result?.valid === true;
  const failures = [];
  if (actualValid !== descriptor.expectedValid) failures.push(`expected valid=${descriptor.expectedValid}, got ${actualValid}`);
  if (fixtureBefore !== fixtureAfter) failures.push("input or schema mutated");
  if (!actualValid) {
    const first = errorList(descriptor, result)?.[0];
    if (typeof first?.code !== "string" || typeof first?.path !== "string" || typeof first?.message !== "string") failures.push("invalid result lacks code/path/message");
  }
  if (descriptor.kind === "server") {
    const delta = effectDelta(before, after);
    const expected = descriptor.expectedValid ? 1 : 0;
    for (const [key, value] of Object.entries(delta)) if (value !== expected) failures.push(`${key} delta ${value} != ${expected}`);
    if (after.prototype !== true) failures.push("server prototype changed");
  }
  return { actualValid, failures, resultHash: digest(result), errorHash: actualValid ? null : digest(errorList(descriptor, result)), effectDelta: effectDelta(before, after), entryHash: digest(after.entry) };
}
async function probeFixture(descriptor, fixture, mutate) {
  const fixtureBefore = fingerprint(fixture.roots);
  const effectsBefore = await fixture.effects();
  const result = await fixture.operation();
  if (mutate && typeof fixture.roots[0] === "object") fixture.roots[0].probeMutation = true;
  const effectsAfter = await fixture.effects();
  const fixtureAfter = fingerprint(fixture.roots);
  const check = checkProbe(descriptor, result, fixtureBefore, fixtureAfter, effectsBefore, effectsAfter);
  return { result, fixtureBefore, fixtureAfter, effectsBefore, effectsAfter, check };
}
async function importApi(root, kind) {
  const packagePath = kind === "server" ? "packages/weaver-server/dist/index.js" : "packages/config-engine/dist/index.js";
  return import(pathToFileURL(join(root, packagePath)));
}
async function runPreflight(descriptors, roots, args) {
  const apis = {};
  const records = [];
  for (const descriptor of descriptors) {
    const variants = descriptor.variants === "both" ? ["base", "tip"] : ["tip"];
    for (const variant of variants) {
      const key = `${variant}:${descriptor.kind}`;
      apis[key] ??= await importApi(roots[variant], descriptor.kind);
      const fixture = await buildFixture(descriptor, apis[key]);
      const changedOracle = args["probe-wrong-oracle"] && records.length === 0;
      const expectedValid = descriptor.expectedValid;
      if (changedOracle) descriptor.expectedValid = !expectedValid;
      const probe = await probeFixture(descriptor, fixture, args["probe-mutation"] && records.length === 0);
      descriptor.expectedValid = expectedValid;
      if (probe.check.failures.length > 0) throw new Error(`${descriptor.id}/${variant}: ${probe.check.failures.join("; ")}`);
      records.push({ id: descriptor.id, variant, expectedValid, ...probe.check, fixtureBefore: probe.fixtureBefore, fixtureAfter: probe.fixtureAfter, effectsBeforeHash: digest(probe.effectsBefore), effectsAfterHash: digest(probe.effectsAfter) });
    }
  }
  verifyOrdinaryAgreement(records, descriptors);
  return { descriptorCount: descriptors.length, recordCount: records.length, records, recordsHash: digest(records), passed: true };
}
function verifyOrdinaryAgreement(records, descriptors) {
  for (const descriptor of descriptors.filter((item) => item.variants === "both")) {
    const base = records.find((item) => item.id === descriptor.id && item.variant === "base");
    const tip = records.find((item) => item.id === descriptor.id && item.variant === "tip");
    if (base.resultHash !== tip.resultHash || base.actualValid !== tip.actualValid) {
      throw new Error(`${descriptor.id}: base/tip ordinary semantic mismatch`);
    }
  }
}
async function calibrate(fixture) {
  let operations = 1;
  const attempts = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const started = performance.now();
    await invokeBatch(fixture, operations);
    const elapsedMs = performance.now() - started;
    attempts.push({ operations, elapsedMs });
    if (elapsedMs >= 100 && elapsedMs <= 250) break;
    const target = Math.max(1, Math.round(operations * 150 / Math.max(elapsedMs, 0.01)));
    operations = elapsedMs > 250 ? Math.max(1, Math.min(operations - 1, target)) : Math.max(operations + 1, target);
  }
  return { operations, attempts };
}
async function warm(fixture, operations) {
  const started = performance.now();
  let batches = 0;
  while (batches < 5 || performance.now() - started < 2000) {
    await invokeBatch(fixture, operations);
    batches += 1;
  }
  return { batches, elapsedMs: performance.now() - started };
}
async function measure(fixture, operations) {
  const before = await fixture.effects();
  const memoryBefore = process.memoryUsage();
  const samplesNs = [];
  const elapsedMs = [];
  let highWaterRss = memoryBefore.rss;
  let highWaterHeap = memoryBefore.heapUsed;
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    globalThis.gc();
    const started = performance.now();
    await invokeBatch(fixture, operations);
    const elapsed = performance.now() - started;
    const memory = process.memoryUsage();
    if (elapsed > 30_000) throw new Error(`sample exceeded 30 seconds: ${elapsed}`);
    if (memory.rss > 1024 ** 3) throw new Error(`RSS exceeded 1 GiB: ${memory.rss}`);
    elapsedMs.push(elapsed);
    samplesNs.push(elapsed * 1e6 / operations);
    highWaterRss = Math.max(highWaterRss, memory.rss);
    highWaterHeap = Math.max(highWaterHeap, memory.heapUsed);
  }
  const after = await fixture.effects();
  globalThis.gc();
  return { before, after, samplesNs, elapsedMs, memoryBefore, memoryAfter: process.memoryUsage(), highWaterRss, highWaterHeap };
}
async function runWorker(args) {
  if (typeof globalThis.gc !== "function") throw new Error("child requires --expose-gc");
  const descriptor = caseDescriptors().find((item) => item.id === args.case);
  if (!descriptor) throw new Error(`unknown case ${args.case}`);
  const importStarted = performance.now();
  const api = await importApi(resolve(args.root), descriptor.kind);
  const importMs = performance.now() - importStarted;
  const setupStarted = performance.now();
  const fixture = await buildFixture(descriptor, api);
  const setupMs = performance.now() - setupStarted;
  const probe = await probeFixture(descriptor, fixture, false);
  if (probe.check.failures.length > 0) throw new Error(probe.check.failures.join("; "));
  const calibrationStarted = performance.now();
  const calibration = await calibrate(fixture);
  const calibrationMs = performance.now() - calibrationStarted;
  const warmup = await warm(fixture, calibration.operations);
  const measured = await measure(fixture, calibration.operations);
  return finishWorker(descriptor, args, probe, calibration, calibrationMs, warmup, measured, { importMs, setupMs }, fixture);
}
function finishWorker(descriptor, args, probe, calibration, calibrationMs, warmup, measured, setup, fixture) {
  const failures = [];
  const finalFingerprint = fingerprint(fixture.roots);
  if (finalFingerprint !== probe.fixtureBefore) failures.push("input or schema mutated during timing");
  const delta = effectDelta(measured.before, measured.after);
  const measuredOperations = calibration.operations * SAMPLE_COUNT;
  if (descriptor.kind === "server") {
    const expected = descriptor.expectedValid ? measuredOperations : 0;
    for (const [key, value] of Object.entries(delta)) if (value !== expected) failures.push(`${key} delta ${value} != ${expected}`);
    if (measured.after.prototype !== true) failures.push("server prototype changed during timing");
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
  return { id: descriptor.id, family: descriptor.family, variant: args.variant, run: Number(args.run), work: descriptor.work ?? null, position: descriptor.position ?? null, operations: calibration.operations, measuredOperations, samplesNs: measured.samplesNs, elapsedMs: measured.elapsedMs, stats: statistics(measured.samplesNs), timings: { ...setup, calibrationMs, calibrationAttempts: calibration.attempts, warmup }, memory: { before: measured.memoryBefore, after: measured.memoryAfter, highWaterRss: measured.highWaterRss, highWaterHeap: measured.highWaterHeap }, correctness: { ...probe.check, fixtureBefore: probe.fixtureBefore, fixtureAfter: finalFingerprint }, effects: { before: measured.before, after: measured.after, delta, entryHash: digest(measured.after.entry) }, affinity: readAffinity() };
}
function readAffinity() {
  const text = execFileSync("sh", ["-c", "awk '/Cpus_allowed_list/ {print $2}' /proc/self/status"], { encoding: "utf8" });
  return text.trim();
}
function timedDescriptors(descriptors) {
  const selected = descriptors.filter((item) => {
    if (item.id.startsWith("ordinary:")) return /:(string|object-100|array-1000)-(valid|invalid)$/.test(item.id) || /^ordinary:(patch|server):/.test(item.id);
    if (/^(anyOf|oneOf):(2|32|128):/.test(item.id)) return true;
    if (/^allOf:distinct:(2|32|128):(all-match|last-failure)$/.test(item.id)) return true;
    if (item.id === "allOf:shared:40") return true;
    if (/^(mixed:32|not:|linear:5000)/.test(item.id)) return true;
    if (/^patch:(allOf:128|shared:40|deferral:|leaf:)/.test(item.id)) return true;
    return item.id.startsWith("server:");
  });
  if (selected.length !== 67) throw new Error(`timed descriptor count ${selected.length} != 67`);
  return selected;
}
function shuffled(values, salt) {
  let state = (SEED ^ salt) >>> 0;
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const selected = (state >>> 0) % (index + 1);
    [output[index], output[selected]] = [output[selected], output[index]];
  }
  return output;
}
function sourceCases(descriptors) {
  const cases = descriptors.flatMap((descriptor) => descriptor.variants === "both"
    ? [{ descriptor, variant: "base" }, { descriptor, variant: "tip" }]
    : [{ descriptor, variant: "tip" }]);
  if (cases.length !== 83) throw new Error(`timed source case count ${cases.length} != 83`);
  return cases;
}
function runChild(item, run, roots, core) {
  const nodeArgs = ["--expose-gc", fileURLToPath(import.meta.url), "--child", "--case", item.descriptor.id, "--variant", item.variant, "--run", String(run), "--root", roots[item.variant]];
  return new Promise((resolvePromise, reject) => {
    const child = spawn("taskset", ["-c", core, process.execPath, ...nodeArgs], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errorOutput += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise(JSON.parse(output)) : reject(new Error(`${item.descriptor.id}/${item.variant}/run${run} exited ${code}: ${errorOutput.trim()}`)));
  });
}
function disturbance(results, before, after) {
  const reasons = [];
  const limit = cpus().length * 0.5;
  if (before[0] >= limit || after[0] >= limit) reasons.push(`one-minute load breached ${limit}`);
  const groups = Map.groupBy(results, (result) => `${result.id}\0${result.variant}`);
  for (const [key, runs] of groups) {
    const medians = runs.map((run) => run.stats.p50);
    const spread = Math.max(...medians) / Math.min(...medians);
    if (spread > 1.2) reasons.push(`${key.replace("\0", "/")} run-median spread ${spread}`);
  }
  return reasons;
}
async function collectAttempt(cases, roots, core, index) {
  const results = [];
  const loadBefore = loadavg();
  for (const item of shuffled(cases, index)) {
    for (let run = 0; run < RUN_COUNT; run += 1) {
      try {
        results.push(await runChild(item, run, roots, core));
      } catch (error) {
        return { index, loadBefore, loadAfter: loadavg(), results, stop: error instanceof Error ? error.message : String(error), disturbed: false, disturbanceReasons: [] };
      }
    }
  }
  const loadAfter = loadavg();
  const disturbanceReasons = disturbance(results, loadBefore, loadAfter);
  return { index, loadBefore, loadAfter, results, stop: null, disturbed: disturbanceReasons.length > 0, disturbanceReasons };
}
function median(values) { return percentile(values, 0.5); }
function aggregateResults(results) {
  const groups = Map.groupBy(results, (result) => `${result.id}\0${result.variant}`);
  return Object.fromEntries([...groups].map(([key, runs]) => [key, { id: runs[0].id, variant: runs[0].variant, family: runs[0].family, work: runs[0].work, position: runs[0].position, p50: median(runs.map((run) => run.stats.p50)), p95: median(runs.map((run) => run.stats.p95)), runP50: runs.map((run) => run.stats.p50), runP95: runs.map((run) => run.stats.p95), cv: runs.map((run) => run.stats.cv), drift: runs.map((run) => run.stats.drift), maxRss: Math.max(...runs.map((run) => run.memory.highWaterRss)), maxHeap: Math.max(...runs.map((run) => run.memory.highWaterHeap)) }]));
}
function timingGates(aggregates) {
  const ordinary = Object.values(aggregates).filter((item) => item.variant === "base").map((base) => {
    const tip = aggregates[`${base.id}\0tip`];
    return { id: base.id, baseP50: base.p50, tipP50: tip.p50, p50Ratio: tip.p50 / base.p50, baseP95: base.p95, tipP95: tip.p95, p95Ratio: tip.p95 / base.p95 };
  });
  const geomean = Math.exp(ordinary.reduce((sum, item) => sum + Math.log(item.p50Ratio), 0) / ordinary.length);
  const scaling = scalingGates(aggregates);
  const server = serverGates(aggregates);
  const failures = [];
  if (geomean > 1.1) failures.push(`ordinary geomean ${geomean} > 1.10`);
  for (const item of ordinary) {
    if (item.p50Ratio > 1.15) failures.push(`${item.id} p50 ratio ${item.p50Ratio} > 1.15`);
    if (item.p95Ratio > 1.2) failures.push(`${item.id} p95 ratio ${item.p95Ratio} > 1.20`);
  }
  for (const item of scaling) if (item.normalized > 1.5) failures.push(`${item.family} ${item.range} normalized ${item.normalized} > 1.50`);
  for (const item of server.filter((entry) => entry.gated)) if (item.ratio > 2) failures.push(`${item.id} ratio ${item.ratio} > 2.0`);
  return { ordinary: { geomean, cases: ordinary }, scaling, server, failures };
}
function scalingGates(aggregates) {
  const rows = [];
  const families = ["anyOf-first", "anyOf-last", "anyOf-none", "anyOf-multiple", "oneOf-first", "oneOf-last", "oneOf-none", "oneOf-multiple", "allOf-distinct-all-match", "allOf-distinct-last-failure"];
  for (const family of families) {
    const values = Object.values(aggregates).filter((item) => item.variant === "tip" && item.family === family);
    for (const [smallWork, largeWork] of [[2, 32], [32, 128], [2, 128]]) {
      const small = values.find((item) => item.work === smallWork);
      const large = values.find((item) => item.work === largeWork);
      rows.push({ family, range: `${smallWork}->${largeWork}`, smallP50: small.p50, largeP50: large.p50, normalized: (large.p50 / small.p50) / (largeWork / smallWork) });
    }
  }
  return rows;
}
function serverGates(aggregates) {
  const validBase = aggregates["ordinary:server:valid\0tip"].p50;
  const invalidBase = aggregates["ordinary:server:invalid\0tip"].p50;
  return Object.values(aggregates).filter((item) => item.id.startsWith("server:")).map((item) => {
    const valid = ["server:anyOf-valid", "server:allOf-valid"].includes(item.id);
    const gated = !["server:not-rejection", "server:shared-40"].includes(item.id);
    return { id: item.id, p50: item.p50, ordinaryP50: valid ? validBase : invalidBase, ratio: item.p50 / (valid ? validBase : invalidBase), gated };
  });
}
function shell(commandName, args, cwd) {
  return execFileSync(commandName, args, { cwd, encoding: "utf8" }).trim();
}
async function verifySource(label, root) {
  const sha = shell("git", ["rev-parse", "HEAD"], root);
  const status = shell("git", ["status", "--porcelain"], root);
  if (sha !== EXPECTED[label]) throw new Error(`${label} SHA ${sha} != ${EXPECTED[label]}`);
  if (status !== "") throw new Error(`${label} source is dirty: ${status}`);
  return { root, sha, tree: shell("git", ["rev-parse", "HEAD^{tree}"], root), packagesTree: shell("git", ["rev-parse", "HEAD:packages"], root), lockHash: createHash("sha256").update(await readFile(join(root, "pnpm-lock.yaml"))).digest("hex"), clean: true };
}
function allowedCores() {
  return readAffinity().split(",").flatMap((part) => {
    const [first, last = first] = part.split("-").map(Number);
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  });
}
function selectCore(requested) {
  const allowed = allowedCores();
  const selected = requested && requested !== "auto" ? Number(requested) : allowed.find((core) => core !== 0);
  if (!Number.isInteger(selected) || selected === 0 || !allowed.includes(selected)) throw new Error(`core must be an allowed non-CPU0 logical CPU; allowed=${allowed.join(",")}`);
  return String(selected);
}
async function optionalText(path) {
  try { return (await readFile(path, "utf8")).trim(); } catch { return null; }
}
async function environment(core) {
  return { capturedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, kernel: release(), node: process.version, v8: process.versions.v8, pnpm: shell("pnpm", ["--version"], here), turbo: shell("pnpm", ["exec", "turbo", "--version"], here), cpu: { model: cpus()[Number(core)]?.model, logicalCount: cpus().length, selectedCore: core, parentAffinity: readAffinity(), siblings: await optionalText(`/sys/devices/system/cpu/cpu${core}/topology/thread_siblings_list`), governor: await optionalText(`/sys/devices/system/cpu/cpu${core}/cpufreq/scaling_governor`), frequencyKHz: await optionalText(`/sys/devices/system/cpu/cpu${core}/cpufreq/scaling_cur_freq`), boost: await optionalText("/sys/devices/system/cpu/cpufreq/boost") }, memory: { total: totalmem(), free: freemem() }, nodeOptions: process.env.NODE_OPTIONS ?? null };
}
async function buildEvidence() {
  try { return JSON.parse(await readFile("/tmp/opencode/weaver-ib06-build-evidence.json", "utf8")); }
  catch { return { recorded: false, reason: "external build-duration evidence was not found" }; }
}
async function writeRaw(path, raw) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
}
async function runMain(args) {
  if (args.seed?.toLowerCase() !== "0xd6615eed") throw new Error("--seed must be 0xD6615EED");
  const roots = { base: resolve(args.base), tip: resolve(args.tip) };
  const output = resolve(args.output ?? join(here, "results/raw.json"));
  const core = selectCore(args.core);
  const sources = { base: await verifySource("base", roots.base), tip: await verifySource("tip", roots.tip) };
  const descriptors = caseDescriptors();
  if (descriptors.length !== 126) throw new Error(`descriptor count ${descriptors.length} != 126`);
  const preflight = await runPreflight(descriptors, roots, args);
  const common = { schemaVersion: 1, seed: `0x${SEED.toString(16).toUpperCase()}`, sources, environment: await environment(core), buildEvidence: await buildEvidence(), fixtureManifestHash: fingerprint(descriptors), preflight, methodology: { sequential: true, core, runs: RUN_COUNT, samplesPerRun: SAMPLE_COUNT, calibrationTargetMs: [100, 250], warmupMinimum: { batches: 5, milliseconds: 2000 }, rerunConditions: ["load >= 0.5 per logical CPU", "max/min process-run p50 > 1.20"], maxCompleteReruns: 1 }, thresholds: { ordinaryGeomean: 1.1, ordinaryP50: 1.15, ordinaryP95: 1.2, normalizedScaling: 1.5, server: 2, sampleMs: 30000, rssBytes: 1024 ** 3 } };
  if (args["preflight-only"]) {
    await writeRaw(output, { ...common, timedDescriptorCount: 0, timedSourceCaseCount: 0, attempts: [], gates: null, verdict: "PASS", reasons: [] });
    return;
  }
  await runTimed(common, descriptors, roots, core, output);
}
async function runTimed(common, descriptors, roots, core, output) {
  const selected = timedDescriptors(descriptors);
  const cases = sourceCases(selected);
  const attempts = [await collectAttempt(cases, roots, core, 0)];
  if (attempts[0].stop === null && attempts[0].disturbed) attempts.push(await collectAttempt(cases, roots, core, 1));
  const accepted = attempts.at(-1);
  let gates = null;
  const reasons = [];
  if (accepted.stop !== null) reasons.push(`hard failure: ${accepted.stop}`);
  if (accepted.disturbed) reasons.push(`canonical matrix disturbed: ${accepted.disturbanceReasons.join("; ")}`);
  if (accepted.stop === null && accepted.results.length === 249) {
    const aggregates = aggregateResults(accepted.results);
    gates = { aggregates, ...timingGates(aggregates) };
    reasons.push(...gates.failures);
  } else if (accepted.stop === null) reasons.push(`child run count ${accepted.results.length} != 249`);
  const verdict = reasons.length === 0 ? "PASS" : "FAIL";
  const raw = { ...common, timedDescriptorCount: selected.length, timedSourceCaseCount: cases.length, attempts, acceptedAttempt: accepted.index, childRunCount: accepted.results.length, sampleCount: accepted.results.length * SAMPLE_COUNT, gates, verdict, reasons };
  await writeRaw(output, raw);
  if (verdict === "FAIL") process.exitCode = 1;
}
const args = parseArgs(process.argv.slice(2));
if (args.child) {
  runWorker(args).then((result) => process.stdout.write(JSON.stringify(result))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  runMain(args).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
