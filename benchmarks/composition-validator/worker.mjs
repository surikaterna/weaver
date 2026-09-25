import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { buildFixture, caseDescriptors, fingerprint } from "./fixtures.mjs";
import { componentHashesV2, digest, legacyPreflightProjectionV1, sampleStats } from "./protocol.mjs";

function fileText(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
}

function childObservation() {
  const status = fileText("/proc/self/status");
  const allowed = status?.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? null;
  const selected = allowed?.includes(",") || allowed?.includes("-") ? null : allowed;
  const cpu = selected ?? String(process.cpuUsage().user >= 0 ? 0 : 0);
  return {
    cpusAllowedList: allowed,
    selectedCpu: selected,
    loadAverage: fileText("/proc/loadavg")?.split(/\s+/).slice(0, 3).map(Number) ?? null,
    governor: fileText(`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_governor`),
    frequencyKHz: fileText(`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_cur_freq`),
    boost: fileText("/sys/devices/system/cpu/cpufreq/boost"),
    siblings: fileText(`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`),
  };
}

async function prepare(args) {
  const descriptor = caseDescriptors().find((item) => item.id === args.case);
  if (!descriptor) throw new Error(`unknown case ${args.case}`);
  const packageName = descriptor.kind === "server" ? "weaver-server" : "config-engine";
  const importStarted = performance.now();
  const api = await import(pathToFileURL(join(resolve(args.root), `packages/${packageName}/dist/index.js`)));
  const importMs = performance.now() - importStarted;
  const setupStarted = performance.now();
  const fixture = await buildFixture(descriptor, api);
  return { descriptor, fixture, importMs, setupMs: performance.now() - setupStarted };
}

function resultErrors(descriptor, result) {
  return descriptor.kind === "server" ? result?.error?.details?.errors : result?.errors;
}

function normalizedServerEffects(descriptor, before, after) {
  if (descriptor.kind !== "server") return null;
  const snapshot = (value) => ({ writes: value.writes, notifications: value.notifications, revisions: value.revisions, entryDigest: digest(value.entry), prototype: value.prototype });
  const delta = Object.fromEntries(["writes", "notifications", "revisions"].map((key) => [key, after[key] - before[key]]));
  return { before: snapshot(before), after: snapshot(after), delta };
}

function correctness(descriptor, result, before, after, effectsBefore, effectsAfter) {
  const actualValid = descriptor.kind === "server" ? result?.success === true : result?.valid === true;
  const failures = [];
  if (actualValid !== descriptor.expectedValid) failures.push(`expected valid=${descriptor.expectedValid}, received ${actualValid}`);
  if (before !== after) failures.push("fixture input or schema mutated");
  if (!actualValid) {
    const first = resultErrors(descriptor, result)?.[0];
    if (typeof first?.code !== "string" || typeof first?.path !== "string" || typeof first?.message !== "string") failures.push("invalid result lacks typed error");
    if ((descriptor.id.startsWith("oneOf:") || descriptor.id.startsWith("allOf:")) && !/matched \d+/.test(first?.message ?? "")) failures.push("composition result lacks matched counter");
  }
  if (descriptor.kind === "server") {
    const expected = descriptor.expectedValid ? 1 : 0;
    for (const key of ["writes", "notifications", "revisions"]) if (effectsAfter[key] - effectsBefore[key] !== expected) failures.push(`${key} probe delta != ${expected}`);
    if (effectsAfter.prototype !== true) failures.push("server input prototype changed");
  }
  return { actualValid, failures };
}

async function probe(args) {
  const prepared = await prepare(args);
  const { descriptor, fixture } = prepared;
  const fixtureBefore = fingerprint(fixture.roots);
  const effectsBefore = await fixture.effects();
  const result = await fixture.operation();
  const effectsAfter = await fixture.effects();
  const fixtureAfter = fingerprint(fixture.roots);
  const check = correctness(descriptor, result, fixtureBefore, fixtureAfter, effectsBefore, effectsAfter);
  if (check.failures.length > 0) throw new Error(check.failures.join("; "));
  const server = normalizedServerEffects(descriptor, effectsBefore, effectsAfter);
  const error = descriptor.kind === "server" ? result?.error : result?.errors;
  return { ...prepared, fixtureBefore, fixtureAfter, effectsBefore, effectsAfter, result, error, server, check };
}

function probeRecord(checked, args) {
  const semantic = {
    id: checked.descriptor.id, variant: args.variant, expectedValid: checked.descriptor.expectedValid,
    actualValid: checked.check.actualValid, resultHash: digest(checked.result), fixtureBefore: checked.fixtureBefore,
    fixtureAfter: checked.fixtureAfter, outcomeDigest: digest(checked.check.actualValid ? checked.result : checked.error),
    server: checked.server, effectHash: digest(checked.server ?? {}),
  };
  const v2Input = { ...semantic, result: checked.result, effectsBefore: checked.effectsBefore, effectsAfter: checked.effectsAfter, entry: checked.effectsAfter.entry, error: checked.error };
  const v2 = componentHashesV2(v2Input, { descriptorOrdinal: Number(args.ordinal), sourceSha: args["source-sha"] });
  return { v1: legacyPreflightProjectionV1(semantic), v2 };
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

async function timedBatch(fixture, operations) {
  const started = performance.now();
  const result = await invokeBatch(fixture, operations);
  return { result, elapsedMs: performance.now() - started };
}

async function warmup(fixture) {
  const started = performance.now();
  let batches = 0;
  while (batches < 20 || performance.now() - started < 10_000) {
    await invokeBatch(fixture, 100);
    batches += 1;
  }
  return { operationsPerBatch: 100, batches, elapsedMs: performance.now() - started };
}

function calibrationCondition(operations, elapsedMs) {
  if (elapsedMs >= 225 && elapsedMs <= 240) return "target";
  if (operations === 100 && elapsedMs > 240 && elapsedMs <= 250) return "minOpsTargetLimited";
  if (operations === 100 && elapsedMs > 250) return "minOpsExceedsAllowed";
  return null;
}

async function calibrate(fixture) {
  let operations = 100;
  const attempts = [];
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const batch = await timedBatch(fixture, operations);
    attempts.push({ attempt, operations, elapsedMs: batch.elapsedMs });
    const condition = calibrationCondition(operations, batch.elapsedMs);
    if (condition) return { attempts, operations, finalBatch: attempts.at(-1), condition };
    operations = Math.max(100, Math.round((operations * 232.5) / Math.max(batch.elapsedMs, 0.01)));
  }
  throw new Error(`calibration did not converge after 12 attempts: ${JSON.stringify(attempts.at(-1))}`);
}

async function postCalibration(fixture, operations) {
  const started = performance.now();
  for (let batch = 0; batch < 3; batch += 1) await invokeBatch(fixture, operations);
  return { batches: 3, elapsedMs: performance.now() - started };
}

function usageDelta(before, after) {
  return { voluntary: after.voluntaryContextSwitches - before.voluntaryContextSwitches, involuntary: after.involuntaryContextSwitches - before.involuntaryContextSwitches };
}

async function measure(fixture, operations, diagnostic) {
  const effectsBefore = await fixture.effects();
  const memoryBefore = process.memoryUsage();
  const samples = [];
  let lastResult;
  let highWaterRss = memoryBefore.rss;
  for (let index = 0; index < 25; index += 1) {
    globalThis.gc();
    const usageBefore = process.resourceUsage();
    const heapBefore = diagnostic ? process.memoryUsage() : null;
    const frequencyBefore = diagnostic ? childObservation().frequencyKHz : null;
    const batch = await timedBatch(fixture, operations);
    const memory = process.memoryUsage();
    highWaterRss = Math.max(highWaterRss, memory.rss);
    if (batch.elapsedMs > 30_000 || memory.rss > 1024 ** 3) throw new Error("sample safety limit exceeded");
    samples.push({ index, batchElapsedMs: batch.elapsedMs, nsPerOperation: (batch.elapsedMs * 1e6) / operations, heapBefore, heapAfter: diagnostic ? memory : null, contextSwitches: diagnostic ? usageDelta(usageBefore, process.resourceUsage()) : null, frequencyBefore, frequencyAfter: diagnostic ? childObservation().frequencyKHz : null });
    lastResult = batch.result;
  }
  return { effectsBefore, effectsAfter: await fixture.effects(), memoryBefore, memoryAfter: process.memoryUsage(), highWaterRss, samples, lastResult };
}

function verifyMeasured(checked, measured, operations) {
  const failures = [];
  if (fingerprint(checked.fixture.roots) !== checked.fixtureBefore) failures.push("fixture mutated during measurement");
  if (checked.descriptor.kind === "server") {
    const expected = checked.descriptor.expectedValid ? operations * 25 : 0;
    for (const key of ["writes", "notifications", "revisions"]) if (measured.effectsAfter[key] - measured.effectsBefore[key] !== expected) failures.push(`${key} measured delta != ${expected}`);
  }
  return failures;
}

export async function preflightWorker(args) {
  const checked = await probe(args);
  return { id: checked.descriptor.id, variant: args.variant, ...probeRecord(checked, args) };
}

export async function measurementWorker(args) {
  if (typeof globalThis.gc !== "function") throw new Error("worker requires --expose-gc");
  const environmentBefore = childObservation();
  const checked = await probe(args);
  const oracle = probeRecord(checked, args);
  if (oracle.v2.aggregate !== args.oracle) throw new Error("worker v2 oracle mismatch");
  const warmupResult = await warmup(checked.fixture);
  const calibration = await calibrate(checked.fixture);
  const postCalibrationResult = await postCalibration(checked.fixture, calibration.operations);
  const measured = await measure(checked.fixture, calibration.operations, args.diagnostic === "true");
  const failures = verifyMeasured(checked, measured, calibration.operations);
  const elapsed = measured.samples.map((sample) => sample.nsPerOperation);
  const methodologyFailures = measured.samples.filter((sample) => calibration.condition !== "minOpsExceedsAllowed" && (sample.batchElapsedMs < 100 || sample.batchElapsedMs > 250));
  if (methodologyFailures.length > 0) failures.push(`${methodologyFailures.length} measured batches outside 100-250ms`);
  return { id: checked.descriptor.id, family: checked.descriptor.family, variant: args.variant, run: Number(args.run), work: checked.descriptor.work ?? null, position: checked.descriptor.position ?? null, operations: calibration.operations, samples: measured.samples, stats: sampleStats(elapsed), timings: { importMs: checked.importMs, setupMs: checked.setupMs, warmup: warmupResult, calibration, postCalibration: postCalibrationResult }, memory: { before: measured.memoryBefore, after: measured.memoryAfter, highWaterRss: measured.highWaterRss }, correctness: { failures, resultHash: digest(measured.lastResult), fixtureBefore: checked.fixtureBefore, fixtureAfter: fingerprint(checked.fixture.roots) }, effects: { before: measured.effectsBefore, after: measured.effectsAfter }, oracleV2: oracle.v2.aggregate, environmentBefore, environmentAfter: childObservation(), diagnostic: args.diagnostic === "true" };
}
