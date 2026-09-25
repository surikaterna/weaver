import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { caseDescriptors, fingerprint, SEED } from "./fixtures.mjs";
import { measurementWorker, preflightWorker } from "./worker.mjs";
import { digest, PILOT_VARIANTS, PREFLIGHT_V1_HASHES, protocolSelfTest, serialize } from "./protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXPECTED = { base: "4fe70d70762460d6656641bfa775121c4ffae058", tip: "e2e79332572261ec526475f40f2ebf08a7f17cdd" };
const OLD = "45788214845d84a83aca54cbb5f5c99cb0fceed5";
const DIAGNOSTIC = new Set(PILOT_VARIANTS.slice(0, 11).map(([id, variant]) => `${id}\0${variant}`));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) parsed[argv[index].slice(2)] = argv[index + 1]?.startsWith("--") ? true : argv[++index];
  }
  return parsed;
}

function command(name, args, cwd = here) {
  return execFileSync(name, args, { cwd, encoding: "utf8" }).trim();
}

async function fileText(path) {
  try { return (await readFile(path, "utf8")).trim(); } catch { return null; }
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, typeof value === "string" ? value : serialize(value));
  await rename(temporary, path);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function verifyRoot(label, root, expected = EXPECTED[label]) {
  const sha = command("git", ["rev-parse", "HEAD"], root);
  const status = command("git", ["status", "--porcelain"], root);
  if (sha !== expected || status !== "") throw new Error(`${label} source identity/cleanliness failed`);
  return { root, sha, tree: command("git", ["rev-parse", "HEAD^{tree}"], root), packagesTree: command("git", ["rev-parse", "HEAD:packages"], root), clean: true };
}

function expandCpuList(text) {
  return text.split(",").flatMap((part) => {
    const [start, end = start] = part.split("-").map(Number);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });
}

function cpuCounters() {
  const lines = execFileSync("sh", ["-c", "while IFS= read -r line; do case \"$line\" in cpu[0-9]*) printf '%s\\n' \"$line\";; esac; done < /proc/stat"], { encoding: "utf8" }).trim().split("\n");
  return new Map(lines.map((line) => {
    const [name, ...raw] = line.trim().split(/\s+/);
    const values = raw.map(Number);
    return [Number(name.slice(3)), { total: values.reduce((sum, value) => sum + value, 0), busy: values.reduce((sum, value, index) => index === 3 || index === 4 ? sum : sum + value, 0) }];
  }));
}

async function cpuScores() {
  const first = cpuCounters();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
  const second = cpuCounters();
  return new Map([...second].map(([cpu, end]) => {
    const start = first.get(cpu);
    return [cpu, (end.busy - start.busy) / (end.total - start.total)];
  }));
}

async function chooseCore(requested) {
  const allowedText = command("taskset", ["-pc", String(process.pid)]).split(":").at(-1).trim();
  const online = new Set(expandCpuList(await fileText("/sys/devices/system/cpu/online")));
  const allowed = expandCpuList(allowedText).filter((cpu) => online.has(cpu));
  const scores = await cpuScores();
  const groups = new Map();
  for (const cpu of allowed) {
    const packageId = Number(await fileText(`/sys/devices/system/cpu/cpu${cpu}/topology/physical_package_id`));
    const coreId = Number(await fileText(`/sys/devices/system/cpu/cpu${cpu}/topology/core_id`));
    const key = `${packageId}:${coreId}`;
    if (!groups.has(key)) groups.set(key, { packageId, coreId, siblings: [] });
    groups.get(key).siblings.push(cpu);
  }
  let eligible = [...groups.values()];
  if (eligible.length > 1) eligible = eligible.filter((group) => !group.siblings.includes(0));
  for (const group of eligible) {
    group.siblings.sort((left, right) => scores.get(left) - scores.get(right) || left - right);
    group.selectedCpu = group.siblings[0];
    group.maxBusy = Math.max(...group.siblings.map((cpu) => scores.get(cpu)));
    group.sumBusy = group.siblings.reduce((sum, cpu) => sum + scores.get(cpu), 0);
  }
  eligible.sort((left, right) => left.maxBusy - right.maxBusy || left.sumBusy - right.sumBusy || left.packageId - right.packageId || left.coreId - right.coreId || left.selectedCpu - right.selectedCpu);
  const selected = requested && requested !== "auto" ? Number(requested) : eligible[0]?.selectedCpu;
  if (!allowed.includes(selected)) throw new Error(`requested core ${requested} is not allowed and online`);
  const group = [...groups.values()].find((item) => item.siblings.includes(selected));
  return { selectedCpu: selected, siblings: group.siblings.sort((a, b) => a - b), packageId: group.packageId, coreId: group.coreId, allowed: allowedText, scores: Object.fromEntries([...scores].filter(([cpu]) => allowed.includes(cpu))) };
}

async function observation(core) {
  return { loadAverage: loadavg(), affinity: command("taskset", ["-pc", String(process.pid)]).split(":").at(-1).trim(), selectedCpu: core.selectedCpu, siblings: core.siblings, governor: await fileText(`/sys/devices/system/cpu/cpu${core.selectedCpu}/cpufreq/scaling_governor`), frequencyKHz: await fileText(`/sys/devices/system/cpu/cpu${core.selectedCpu}/cpufreq/scaling_cur_freq`), boost: await fileText("/sys/devices/system/cpu/cpufreq/boost") };
}

function assertIdle() {
  const conflicts = command("ps", ["-eo", "pid=,comm=,args="]).split("\n").filter((line) => {
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (pid === process.pid || pid === process.ppid) return false;
    return /\bturbo\b/.test(line) || /node .*--test/.test(line) || /node .*runner\.mjs/.test(line);
  });
  if (conflicts.length > 0) throw new Error(`concurrent benchmark/Turbo/test process: ${conflicts[0]}`);
  if (loadavg()[0] >= cpus().length * 0.5) throw new Error(`one-minute load gate failed: ${loadavg()[0]}`);
}

function childArguments(mode, item, roots, oracle, diagnostic) {
  return ["--expose-gc", ...(diagnostic ? ["--trace-gc-nvp"] : []), fileURLToPath(import.meta.url), "--worker", mode, "--case", item.id, "--variant", item.variant, "--root", roots[item.variant].root, "--ordinal", String(item.descriptorOrdinal), "--source-sha", roots[item.variant].sha, "--run", String(item.run ?? 0), ...(oracle ? ["--oracle", oracle] : []), ...(diagnostic ? ["--diagnostic", "true"] : [])];
}

function runChild(mode, item, context, options = {}) {
  const args = ["-c", String(context.core.selectedCpu), process.execPath, ...childArguments(mode, item, context.roots, options.oracle, options.diagnostic)];
  return new Promise((resolvePromise, reject) => {
    const child = spawn("taskset", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1024" } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${item.id}/${item.variant} timeout120`)); }, 120_000);
    child.on("error", reject);
    child.on("exit", async (code) => {
      clearTimeout(timer);
      if (options.tracePath) await writeFile(options.tracePath, output);
      const marker = output.split("\n").filter((line) => line.startsWith("RESULT:")).at(-1);
      if (code === 0 && marker) resolvePromise(JSON.parse(marker.slice(7)));
      else reject(new Error(`${item.id}/${item.variant} exited ${code}: ${output.slice(-500)}`));
    });
  });
}

function preflightSchedule() {
  return caseDescriptors().flatMap((descriptor, descriptorOrdinal) => (descriptor.variants === "both" ? ["base", "tip"] : ["tip"]).map((variant) => ({ id: descriptor.id, variant, descriptorOrdinal })));
}

function preflightHashes(records) {
  return { base: digest(records.filter((record) => record.variant === "base").map((record) => record.v1)), tip: digest(records.filter((record) => record.variant === "tip").map((record) => record.v1)), overall: digest(records.map((record) => record.v1)) };
}

async function runPreflight(context) {
  const records = [];
  for (const [preflightOrdinal, item] of preflightSchedule().entries()) {
    const result = await runChild("preflight", item, context);
    records.push({ ...item, preflightOrdinal, ...result });
    await atomicWrite(join(context.directory, "preflight-progress.json"), { records });
  }
  const hashes = preflightHashes(records);
  if (JSON.stringify(hashes) !== JSON.stringify(PREFLIGHT_V1_HASHES)) throw new Error(`fatal v1 hash mismatch: ${JSON.stringify(hashes)}`);
  const v2 = Object.fromEntries(records.map((record) => [`${record.id}\0${record.variant}`, record.v2.aggregate]));
  const value = { status: "PASS", recordCount: records.length, hashes, componentHashVersion: 2, v2Aggregate: digest(records.map((record) => record.v2)), v2, records };
  await atomicWrite(join(context.directory, "preflight.json"), value);
  return value;
}

async function runFocused(context, oldRoot) {
  const old = await verifyRoot("old", resolve(oldRoot), OLD);
  const ids = [10, 20, 30, 40].map((depth) => `patch:shared:${depth}`);
  const probes = [];
  for (const id of ids) probes.push(await runChild("preflight", { id, variant: "tip", descriptorOrdinal: caseDescriptors().findIndex((item) => item.id === id) }, { ...context, roots: { ...context.roots, tip: old } }));
  for (const [id, variant] of PILOT_VARIANTS.slice(0, 4)) probes.push(await runChild("preflight", { id, variant, descriptorOrdinal: caseDescriptors().findIndex((item) => item.id === id) }, context));
  const shared = "server:shared-40";
  probes.push(await runChild("preflight", { id: shared, variant: "tip", descriptorOrdinal: caseDescriptors().findIndex((item) => item.id === shared) }, context));
  return { oldSharedDepths: ids, ordinaryServerSources: 4, fixedSharedServer: true, probes: probes.length };
}

function shuffledDescriptors() {
  let state = SEED >>> 0;
  const output = [...caseDescriptors()];
  for (let index = output.length - 1; index > 0; index -= 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const selected = (state >>> 0) % (index + 1);
    [output[index], output[selected]] = [output[selected], output[index]];
  }
  return output;
}

function restrictedSchedule() {
  const permitted = new Set(PILOT_VARIANTS.map(([id]) => id));
  return shuffledDescriptors().filter((descriptor) => permitted.has(descriptor.id)).flatMap((descriptor) => {
    const descriptorOrdinal = caseDescriptors().findIndex((item) => item.id === descriptor.id);
    const variants = descriptor.variants === "both" ? ["base", "tip", "tip", "base", "base", "tip"] : ["tip", "tip", "tip"];
    const counts = { base: 0, tip: 0 };
    return variants.map((variant) => ({ id: descriptor.id, variant, descriptorOrdinal, run: counts[variant]++ }));
  });
}

function verifyEnvironment(result, before, after, core) {
  const failures = [];
  if (result.environmentBefore.cpusAllowedList !== String(core.selectedCpu) || result.environmentAfter.cpusAllowedList !== String(core.selectedCpu)) failures.push("child affinity mismatch/migration");
  if (result.environmentBefore.governor !== result.environmentAfter.governor || before.governor !== after.governor) failures.push("governor changed");
  if (before.loadAverage[0] >= cpus().length * 0.5 || after.loadAverage[0] >= cpus().length * 0.5) failures.push("load gate violation");
  return failures;
}

async function runMeasured(item, context, preflight, diagnostic, ordinal) {
  assertIdle();
  const before = await observation(context.core);
  const tracePath = diagnostic ? join(context.directory, `diagnostic-${String(ordinal).padStart(2, "0")}-${item.id.replaceAll(":", "_")}-${item.variant}.log`) : null;
  const result = await runChild("measure", item, context, { oracle: preflight.v2[`${item.id}\0${item.variant}`], diagnostic, tracePath });
  const after = await observation(context.core);
  result.correctness.failures.push(...verifyEnvironment(result, before, after, context.core));
  return { ...result, parentEnvironmentBefore: before, parentEnvironmentAfter: after, tracePath: diagnostic ? tracePath : null };
}

async function runDiagnostic(context, preflight) {
  const items = PILOT_VARIANTS.slice(0, 11).map(([id, variant]) => ({ id, variant, descriptorOrdinal: caseDescriptors().findIndex((item) => item.id === id), run: 0 }));
  const results = [];
  for (const [ordinal, item] of items.entries()) results.push(await runMeasured(item, context, preflight, true, ordinal));
  const summary = results.map((result) => ({ id: result.id, variant: result.variant, cv: result.stats.cv, drift: result.stats.drift, heapGrowth: result.samples.map((sample) => sample.heapAfter.heapUsed - sample.heapBefore.heapUsed), contextSwitches: result.samples.map((sample) => sample.contextSwitches), tracePath: result.tracePath }));
  await atomicWrite(join(context.directory, "diagnostic.json"), { timingsExcluded: true, results: summary });
  return summary;
}

async function runPilot(context, preflight) {
  const results = [];
  for (const [ordinal, item] of restrictedSchedule().entries()) {
    const result = await runMeasured(item, context, preflight, false, ordinal);
    results.push(result);
    await atomicWrite(join(context.directory, "pilot-progress.json"), { results });
    if (result.stats.cv >= 0.05 || result.stats.drift >= 0.05 || result.correctness.failures.length > 0) break;
  }
  const complete = results.length === 48;
  const go = complete && results.every((result) => result.stats.cv < 0.05 && result.stats.drift < 0.05 && result.correctness.failures.length === 0);
  const value = { verdict: go ? "GO" : "INVESTIGATE", complete, runCount: results.length, sampleCount: results.length * 25, results };
  await atomicWrite(join(context.directory, "pilot.json"), value);
  return value;
}

function fullSchedule(set) {
  return shuffledDescriptors().flatMap((descriptor) => {
    const descriptorOrdinal = caseDescriptors().findIndex((item) => item.id === descriptor.id);
    const variants = descriptor.variants === "both" ? (set % 2 === 0 ? ["base", "tip", "tip", "base", "base", "tip"] : ["tip", "base", "base", "tip", "tip", "base"]) : ["tip", "tip", "tip"];
    const counts = { base: 0, tip: 0 };
    return variants.map((variant) => ({ id: descriptor.id, variant, descriptorOrdinal, run: counts[variant]++ }));
  }).map((item, globalRunOrdinal) => ({ ...item, globalRunOrdinal }));
}

function shardItems(set, shard) {
  const start = Math.floor((shard * 126) / 16);
  const end = Math.floor(((shard + 1) * 126) / 16);
  return fullSchedule(set).filter((item) => item.descriptorOrdinal >= start && item.descriptorOrdinal < end);
}

async function runShard(context, preflight, set, shard) {
  const directory = join(context.directory, "fragments", `set-${set}`);
  await mkdir(directory, { recursive: true });
  for (const item of shardItems(set, shard)) {
    const path = join(directory, `${String(item.globalRunOrdinal).padStart(3, "0")}.json`);
    try { await readFile(path); continue; } catch { /* absent fragments are measured */ }
    const result = await runMeasured(item, context, preflight, false, item.globalRunOrdinal);
    await atomicWrite(path, { protocolVersion: 2, set, shard, ...item, result, digest: digest({ set, shard, ...item, result }) });
  }
  await atomicWrite(join(context.directory, `set-${set}-shard-${shard}.json`), { set, shard, status: "complete", runCount: shardItems(set, shard).length });
}

async function mergeSet(context, set) {
  const expected = fullSchedule(set);
  const names = (await readdir(join(context.directory, "fragments", `set-${set}`))).filter((name) => name.endsWith(".json")).sort();
  if (names.length !== 462) throw new Error(`set ${set} fragment count ${names.length}`);
  const fragments = await Promise.all(names.map((name) => readJson(join(context.directory, "fragments", `set-${set}`, name))));
  for (const [index, fragment] of fragments.entries()) if (fragment.globalRunOrdinal !== index || fragment.id !== expected[index].id) throw new Error(`set ${set} order mismatch at ${index}`);
  const results = fragments.map((fragment) => fragment.result);
  const noisy = results.filter((result) => result.stats.cv >= 0.05 || result.stats.drift >= 0.05 || result.correctness.failures.length > 0);
  const value = { set, discarded: noisy.length > 0, reason: noisy.length > 0 ? `${noisy.length} run(s) failed stability/correctness` : null, results };
  await atomicWrite(join(context.directory, `set-${set}.json`), value);
  return value;
}

async function initialize(args) {
  protocolSelfTest();
  const directory = resolve(args.directory);
  await mkdir(directory, { recursive: true });
  assertIdle();
  const roots = { base: await verifyRoot("base", resolve(args.base)), tip: await verifyRoot("tip", resolve(args.tip)) };
  const core = await chooseCore(args.core ?? "auto");
  const context = { directory, roots, core };
  await atomicWrite(join(directory, "environment.json"), { protocolVersion: 2, roots, core, fixtureManifestHash: fingerprint(caseDescriptors()), node: process.version, v8: process.versions.v8, initial: await observation(core) });
  return context;
}

async function main(args) {
  if (args.worker) {
    const result = args.worker === "preflight" ? await preflightWorker(args) : await measurementWorker(args);
    process.stdout.write(`RESULT:${JSON.stringify(result)}\n`);
    return;
  }
  if (args.phase === "self-test") { process.stdout.write(`${JSON.stringify(protocolSelfTest())}\n`); return; }
  const context = await initialize(args);
  if (args.phase === "preflight") { process.stdout.write(`${JSON.stringify(await runPreflight(context))}\n`); return; }
  const preflight = await readJson(join(context.directory, "preflight.json"));
  if (args.phase === "focused") { process.stdout.write(`${JSON.stringify(await runFocused(context, args.old))}\n`); return; }
  if (args.phase === "diagnostic") { process.stdout.write(`${JSON.stringify(await runDiagnostic(context, preflight))}\n`); return; }
  if (args.phase === "pilot") { process.stdout.write(`${JSON.stringify(await runPilot(context, preflight))}\n`); return; }
  if (args.phase === "shard") { await runShard(context, preflight, Number(args.set), Number(args.shard)); return; }
  if (args.phase === "merge-set") { process.stdout.write(`${JSON.stringify(await mergeSet(context, Number(args.set)))}\n`); return; }
  throw new Error(`unknown phase ${args.phase}`);
}

main(parseArgs(process.argv.slice(2))).catch((error) => { console.error(error); process.exitCode = 1; });
