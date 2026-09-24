import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { caseDescriptors, fingerprint, SEED } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXPECTED = { base: "4fe70d70762460d6656641bfa775121c4ffae058", tip: "45788214845d84a83aca54cbb5f5c99cb0fceed5" };

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--")) parsed[argument.slice(2)] = argv[index + 1]?.startsWith("--") ? true : argv[++index];
  }
  return parsed;
}

function stable(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function serializeRaw(raw) {
  return `${JSON.stringify(raw, null, 2).replace(/"loadAverage": \[\n\s+([\d.]+),\n\s+([\d.]+),\n\s+([\d.]+)\n\s+\]/, '"loadAverage": [$1, $2, $3]')}\n`;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function stats(samples) {
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  const mad = percentile(samples.map((value) => Math.abs(value - p50)), 0.5);
  const first = percentile(samples.slice(0, 5), 0.5);
  const last = percentile(samples.slice(-5), 0.5);
  return { p50, p95, mad, cv: Math.sqrt(variance) / mean, drift: Math.abs(last - first) / first, opsPerSecond: 1e9 / p50 };
}

async function invokeBatch(fixture, operations) {
  let result;
  if (fixture.async) {
    for (let index = 0; index < operations; index += 1) result = await fixture.operation();
  } else {
    for (let index = 0; index < operations; index += 1) result = fixture.operation();
  }
  return result;
}

async function calibrate(fixture) {
  let operations = 100;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const started = performance.now();
    await invokeBatch(fixture, operations);
    const elapsed = performance.now() - started;
    if (elapsed >= 100 && elapsed <= 250) return operations;
    if (elapsed > 250) return Math.max(100, Math.floor(operations * 150 / elapsed));
    operations = Math.max(operations + 1, Math.ceil(operations * 150 / Math.max(elapsed, 0.01)));
  }
  return operations;
}

async function measure(fixture, operations) {
  const measuredEffectsBefore = await fixture.effects();
  const memoryBefore = process.memoryUsage();
  const samples = [];
  let highWaterRss = memoryBefore.rss;
  let highWaterHeap = memoryBefore.heapUsed;
  let lastResult;
  for (let sample = 0; sample < 25; sample += 1) {
    globalThis.gc();
    const started = performance.now();
    lastResult = await invokeBatch(fixture, operations);
    const elapsed = performance.now() - started;
    if (elapsed > 30_000) throw new Error(`sample exceeded 30 seconds: ${elapsed}`);
    samples.push(elapsed * 1e6 / operations);
    const memory = process.memoryUsage();
    highWaterRss = Math.max(highWaterRss, memory.rss);
    highWaterHeap = Math.max(highWaterHeap, memory.heapUsed);
    if (memory.rss > 1024 ** 3) throw new Error(`RSS exceeded 1 GiB: ${memory.rss}`);
  }
  const measuredEffectsAfter = await fixture.effects();
  const memoryAfter = process.memoryUsage();
  globalThis.gc();
  return { measuredEffectsBefore, measuredEffectsAfter, memoryBefore, memoryAfter, memoryPostGc: process.memoryUsage(), samples, highWaterRss, highWaterHeap, lastResult };
}

function correctness(descriptor, result, before, after, effectsBefore, effectsAfter) {
  const actualValid = descriptor.kind === "server" ? result?.success === true : result?.valid === true;
  const failures = [];
  if (actualValid !== descriptor.expectedValid) failures.push(`expected valid=${descriptor.expectedValid}, received ${actualValid}`);
  if (before !== after) failures.push("fixture input or schema mutated");
  if (!actualValid) {
    const errors = descriptor.kind === "server" ? result?.error?.details?.errors : result?.errors;
    const first = errors?.[0];
    if (typeof first?.code !== "string" || typeof first?.path !== "string" || typeof first?.message !== "string") failures.push("invalid result lacks exact code/path/message");
    if ((descriptor.id.startsWith("oneOf:") || descriptor.id.startsWith("allOf:")) && !/matched \d+/.test(first?.message ?? "")) failures.push("composition result lacks matched counter");
  }
  if (!descriptor.expectedValid && descriptor.kind === "server") {
    for (const key of ["writes", "notifications", "revisions"]) if (effectsAfter[key] !== effectsBefore[key]) failures.push(`invalid server ${key} changed`);
  }
  if (descriptor.kind === "server" && effectsAfter.prototype !== true) failures.push("server input prototype changed");
  return { actualValid, failures, resultHash: digest(result) };
}

async function worker(args) {
  if (typeof globalThis.gc !== "function") throw new Error("worker requires --expose-gc");
  const descriptor = caseDescriptors().find((item) => item.id === args.case);
  if (!descriptor) throw new Error(`unknown case ${args.case}`);
  const root = resolve(args.root);
  const importStarted = performance.now();
  const api = await import(pathToFileURL(join(root, descriptor.kind === "server" ? "packages/weaver-server/dist/index.js" : "packages/config-engine/dist/index.js")));
  const importMs = performance.now() - importStarted;
  const setupStarted = performance.now();
  const fixture = await (await import("./fixtures.mjs")).buildFixture(descriptor, api);
  const setupMs = performance.now() - setupStarted;
  const before = fingerprint(fixture.roots);
  const effectsBeforeProbe = await fixture.effects();
  const probe = await fixture.operation();
  const effectsAfterProbe = await fixture.effects();
  const after = fingerprint(fixture.roots);
  const check = correctness(descriptor, probe, before, after, effectsBeforeProbe, effectsAfterProbe);
  if (check.failures.length > 0) throw new Error(check.failures.join("; "));
  const calibrationStarted = performance.now();
  const operations = await calibrate(fixture);
  const calibrationMs = performance.now() - calibrationStarted;
  const warmupStarted = performance.now();
  let warmupBatches = 0;
  while (warmupBatches < 5 || performance.now() - warmupStarted < 2000) { await invokeBatch(fixture, operations); warmupBatches += 1; }
  const warmupMs = performance.now() - warmupStarted;
  const measured = await measure(fixture, operations);
  const { measuredEffectsBefore, measuredEffectsAfter, memoryBefore, memoryAfter, memoryPostGc, samples, highWaterRss, highWaterHeap, lastResult } = measured;
  const fixtureFinal = fingerprint(fixture.roots);
  if (fixtureFinal !== before) check.failures.push("fixture input or schema mutated during measurement");
  const measuredOperations = operations * samples.length;
  const effectDelta = Object.fromEntries(["writes", "notifications", "revisions"].map((key) => [key, (measuredEffectsAfter[key] ?? 0) - (measuredEffectsBefore[key] ?? 0)]));
  if (descriptor.kind === "server") {
    const expected = descriptor.expectedValid ? measuredOperations : 0;
    for (const [key, value] of Object.entries(effectDelta)) if (value !== expected) check.failures.push(`${key} ${value} != ${expected}`);
  }
  return { id: descriptor.id, family: descriptor.family, variant: args.variant, run: Number(args.run), set: Number(args.set), work: descriptor.work ?? null, position: descriptor.position ?? null, operations, measuredOperations, samples, stats: stats(samples), timings: { importMs, setupMs, calibrationMs, warmupMs, warmupBatches }, memory: { before: memoryBefore, after: memoryAfter, highWaterRss, highWaterHeap, postGc: memoryPostGc, postGcRssDelta: memoryPostGc.rss - memoryBefore.rss, postGcHeapDelta: memoryPostGc.heapUsed - memoryBefore.heapUsed }, correctness: { ...check, finalResultHash: digest(lastResult), fixtureBefore: before, fixtureAfter: fixtureFinal }, effects: { before: measuredEffectsBefore, after: measuredEffectsAfter, delta: effectDelta, entryDigest: digest(measuredEffectsAfter.entry), errorDigest: descriptor.expectedValid ? null : digest(lastResult) } };
}

function command(commandName, args, cwd) {
  return execFileSync(commandName, args, { cwd, encoding: "utf8" }).trim();
}

async function fileText(path) {
  try { return (await readFile(path, "utf8")).trim(); } catch { return null; }
}

async function verifyRoot(label, root) {
  const sha = command("git", ["rev-parse", "HEAD"], root);
  if (sha !== EXPECTED[label]) throw new Error(`${label} SHA ${sha} != ${EXPECTED[label]}`);
  const status = command("git", ["status", "--porcelain"], root);
  if (status !== "") throw new Error(`${label} worktree is dirty: ${status}`);
  return { root, sha, tree: command("git", ["rev-parse", "HEAD^{tree}"], root), packagesTree: command("git", ["rev-parse", "HEAD:packages"], root), clean: true };
}

function shuffled(values) {
  let state = SEED >>> 0;
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const selected = (state >>> 0) % (index + 1);
    [output[index], output[selected]] = [output[selected], output[index]];
  }
  return output;
}

function selectedCore(requested) {
  if (requested && requested !== "auto") return requested;
  const status = execFileSync("sh", ["-c", "awk '/Cpus_allowed_list/ {print $2}' /proc/self/status"], { encoding: "utf8" }).trim();
  return status.split(",")[0].split("-")[0];
}

function runChild({ descriptor, variant, run, set, root, core }) {
  const nodeArgs = ["--expose-gc", fileURLToPath(import.meta.url), "--worker", "true", "--case", descriptor.id, "--variant", variant, "--run", String(run), "--set", String(set), "--root", root];
  const executable = core === "none" ? process.execPath : "taskset";
  const args = core === "none" ? nodeArgs : ["-c", core, process.execPath, ...nodeArgs];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise(JSON.parse(output)) : reject(new Error(`${descriptor.id}/${variant} exited ${code}`)));
  });
}

async function environment(core) {
  const cpu = cpus()[Number(core) || 0] ?? cpus()[0];
  return { capturedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, release: command("uname", ["-r"], here), hostname: command("hostname", [], here), node: process.version, v8: process.versions.v8, pnpm: command("pnpm", ["--version"], here), turbo: command("pnpm", ["exec", "turbo", "--version"], here), cpu: { model: cpu.model, speedMHz: cpu.speed, logicalCount: cpus().length, selectedCore: core, affinity: command("taskset", ["-pc", String(process.pid)], here), topology: await fileText(`/sys/devices/system/cpu/cpu${core}/topology/thread_siblings_list`), cache: await fileText(`/sys/devices/system/cpu/cpu${core}/cache/index3/size`), governor: await fileText(`/sys/devices/system/cpu/cpu${core}/cpufreq/scaling_governor`), frequencyKHz: await fileText(`/sys/devices/system/cpu/cpu${core}/cpufreq/scaling_cur_freq`), boost: await fileText("/sys/devices/system/cpu/cpufreq/boost") }, memory: { total: totalmem(), free: freemem(), swap: await fileText("/proc/swaps") }, loadAverage: loadavg(), nodeOptions: process.env.NODE_OPTIONS ?? null, container: await fileText("/.dockerenv"), thermal: await fileText("/sys/class/thermal/thermal_zone0/temp"), acOnline: await fileText("/sys/class/power_supply/AC/online"), commandLine: process.argv };
}

function schedules(descriptors, set) {
  const schedule = [];
  for (const descriptor of shuffled(descriptors)) {
    if (descriptor.variants === "both") {
      const sequence = set % 2 === 0 ? ["base", "tip", "tip", "base", "base", "tip"] : ["tip", "base", "base", "tip", "tip", "base"];
      const counts = { base: 0, tip: 0 };
      for (const variant of sequence) schedule.push({ descriptor, variant, run: counts[variant]++ });
    } else {
      for (let run = 0; run < 3; run += 1) schedule.push({ descriptor, variant: "tip", run });
    }
  }
  return schedule;
}

async function collectSets(descriptors, roots, core) {
  const sets = [];
  for (let set = 0; set < 3; set += 1) {
    const results = [];
    const loadBefore = loadavg();
    for (const item of schedules(descriptors, set)) {
      try {
        const root = roots[item.variant];
        results.push(await runChild({ ...item, set, root, core }));
      } catch (error) {
        const stop = { matrixComplete: false, verdict: "FAIL", case: item.descriptor.id, variant: item.variant, phase: "child setup or measurement", reason: error instanceof Error ? error.message : String(error), observedAt: new Date().toISOString(), stableRuns: 0, completedSamples: results.length * 25 };
        return { sets, stop };
      }
    }
    const unstable = results.some((result) => result.stats.cv > 0.05 || result.stats.drift > 0.05);
    sets.push({ set, discarded: unstable, reason: unstable ? "sample CV or first/last-five median drift exceeded 5%" : null, loadBefore, loadAfter: loadavg(), results });
    if (!unstable) break;
  }
  return { sets, stop: null };
}

async function main(args) {
  if (args.seed && args.seed.toLowerCase() !== "0xd6615eed") throw new Error(`seed is frozen at 0xD6615EED, received ${args.seed}`);
  const base = resolve(args.base);
  const tip = resolve(args.tip);
  const output = resolve(args.output ?? join(here, "results/raw.json"));
  const core = args.core === "none" ? "none" : selectedCore(args.core);
  const sources = { base: await verifyRoot("base", base), tip: await verifyRoot("tip", tip) };
  const lockfileHash = createHash("sha256").update(await readFile(join(tip, "pnpm-lock.yaml"))).digest("hex");
  const descriptors = caseDescriptors();
  const manifestHash = fingerprint(descriptors);
  const initialEnvironment = await environment(core === "none" ? "0" : core);
  const buildEvidence = { commands: ["pnpm install --frozen-lockfile", "pnpm exec turbo run build --filter=@weaver-conf/config-engine... --force --output-logs=errors-only", "pnpm exec turbo run build --filter=@weaver-conf/weaver-server... --force --output-logs=errors-only"], milliseconds: { baseInstall: Number(args["base-install-ms"]) || null, tipInstall: Number(args["tip-install-ms"]) || null, baseEngine: Number(args["base-engine-build-ms"]) || null, tipEngine: Number(args["tip-engine-build-ms"]) || null, baseServer: Number(args["base-server-build-ms"]) || null, tipServer: Number(args["tip-server-build-ms"]) || null } };
  const common = { schemaVersion: 1, seed: `0x${SEED.toString(16).toUpperCase()}`, methodology: { processIsolation: "one case/run per child", gc: "before each measured sample", calibration: "100-250ms and >=100 operations", warmup: ">=5 batches and >=2 seconds", runs: 3, samplesPerRun: 25, order: "paired ABBAAB; seeded case shuffle", stability: "reject set when any run CV or first/last-five median drift >5%; at most two replacements" }, thresholds: { ordinary: { geomeanPass: 1.10, p50Pass: 1.15, p95Pass: 1.20, geomeanFail: 1.20, p50Fail: 1.30, p95Fail: 1.40 }, scaling: { pass: 1.50, fail: 2.50 }, server: { pass: 2, fail: 4 }, memory: { investigatePostGcBytes: 128 * 1024 ** 2, failRssBytes: 1024 ** 3 } }, sources, lockfileHash, fixtureManifestHash: manifestHash, environment: initialEnvironment, buildEvidence };
  if (args["observed-stop-case"]) {
    const raw = { ...common, sets: [], acceptedSet: null, correctnessFailures: [], stop: { matrixComplete: false, verdict: "FAIL", case: args["observed-stop-case"], phase: args["stop-phase"] ?? "fixture setup", reason: args["stop-reason"] ?? "child process crashed", observedAt: new Date().toISOString(), stableRuns: 0, completedSamples: 0 } };
    await writeFile(output, serializeRaw(raw));
    process.stdout.write(`${output}\n`);
    return;
  }
  const { sets, stop } = await collectSets(descriptors, { base, tip }, core);
  if (stop !== null) {
    await writeFile(output, serializeRaw({ ...common, sets, acceptedSet: null, correctnessFailures: [], stop }));
    process.stdout.write(`${output}\n`);
    process.exitCode = 1;
    return;
  }
  const accepted = sets.find((set) => !set.discarded) ?? sets.at(-1);
  const failures = accepted.results.flatMap((result) => result.correctness.failures.map((failure) => `${result.id}/${result.variant}: ${failure}`));
  for (const descriptor of descriptors.filter((item) => item.variants === "both")) {
    const baseResult = accepted.results.find((result) => result.id === descriptor.id && result.variant === "base");
    const tipResult = accepted.results.find((result) => result.id === descriptor.id && result.variant === "tip");
    if (baseResult?.correctness.resultHash !== tipResult?.correctness.resultHash) failures.push(`${descriptor.id}: ordinary base/tip result hash mismatch`);
  }
  const raw = { ...common, sets, acceptedSet: accepted.set, correctnessFailures: failures, stop: null };
  await writeFile(output, serializeRaw(raw));
  process.stdout.write(`${output}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.worker) {
  worker(args).then((result) => process.stdout.write(JSON.stringify(result))).catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  main(args).catch((error) => { console.error(error); process.exitCode = 1; });
}
