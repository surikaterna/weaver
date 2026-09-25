import { createHash } from "node:crypto";

export const PROTOCOL_VERSION = 2;
export const PREFLIGHT_V1_HASHES = Object.freeze({
  base: "8370390cee259459893699f2e8faeb547a30adce6acc4ae5fdb4c8941fad7507",
  tip: "57ad8bc0d3bedcce30ef706c0c08bc4d5258956e133e96217af440b2e2903faa",
  overall: "9baa9533cca5fef57ff410dd669d118035a04acedfb7756d068f9d4792542bbb",
});

export const PILOT_VARIANTS = Object.freeze([
  ["ordinary:server:valid", "base"], ["ordinary:server:valid", "tip"],
  ["ordinary:server:invalid", "base"], ["ordinary:server:invalid", "tip"],
  ["server:not-rejection", "tip"], ["server:allOf-valid", "tip"],
  ["server:allOf-invalid", "tip"], ["server:anyOf-valid", "tip"],
  ["server:anyOf-invalid", "tip"], ["server:oneOf-ambiguity", "tip"],
  ["server:shared-40", "tip"], ["ordinary:partial:array-100-valid", "base"],
  ["ordinary:partial:array-100-valid", "tip"], ["mixed:32:invalid", "tip"],
  ["linear:5000:valid", "tip"], ["linear:5000:invalid", "tip"],
]);

export function canonicalize(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function canonicalBytes(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

export function digest(value) {
  return sha256Bytes(canonicalBytes(value));
}

export function legacyPreflightProjectionV1(probe) {
  return {
    id: probe.id,
    variant: probe.variant,
    expectedValid: probe.expectedValid,
    actualValid: probe.actualValid,
    resultHash: probe.resultHash,
    fixtureBefore: probe.fixtureBefore,
    fixtureAfter: probe.fixtureAfter,
    outcomeDigest: probe.outcomeDigest,
    server: probe.server,
    effectHash: probe.effectHash,
  };
}

export function componentHashesV2(probe, identity) {
  const components = {
    result: digest(probe.result),
    fixtureBefore: digest(probe.fixtureBefore),
    fixtureAfter: digest(probe.fixtureAfter),
    effectsBefore: digest(probe.effectsBefore),
    effectsAfter: digest(probe.effectsAfter),
    entry: digest(probe.entry),
    error: digest(probe.error),
  };
  const record = {
    version: 2,
    descriptorOrdinal: identity.descriptorOrdinal,
    id: probe.id,
    variant: probe.variant,
    sourceSha: identity.sourceSha,
    expectedValid: probe.expectedValid,
    actualValid: probe.actualValid,
    components,
  };
  return { components, aggregate: digest(record) };
}

const V1_GOLDEN_BYTES = "{\"actualValid\":true,\"effectHash\":\"ee\",\"expectedValid\":true,\"fixtureAfter\":\"fa\",\"fixtureBefore\":\"fb\",\"id\":\"case\",\"outcomeDigest\":\"od\",\"resultHash\":\"rh\",\"server\":null,\"variant\":\"tip\"}";
const V1_GOLDEN_SHA = "14534398c406999e9aceea200fb00449780d5016432b8eb54be1ea397e8472e2";
const V2_GOLDEN_BYTES = "{\"actualValid\":false,\"components\":{\"effectsAfter\":\"ea\",\"effectsBefore\":\"eb\",\"entry\":\"en\",\"error\":\"er\",\"fixtureAfter\":\"fa\",\"fixtureBefore\":\"fb\",\"result\":\"rs\"},\"descriptorOrdinal\":7,\"expectedValid\":false,\"id\":\"case\",\"sourceSha\":\"sha\",\"variant\":\"base\",\"version\":2}";
const V2_GOLDEN_SHA = "5c6659c48dd00bbe6b1dddfc2d5ee2bf2fe9b46dc9d8c02361ca3a8307103f47";

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: ${actual} != ${expected}`);
}

function assertMutationFails(bytes, expectedSha, label) {
  if (sha256Bytes(bytes.replace("case", "mutated")) === expectedSha) throw new Error(`${label} mutation passed`);
  if (sha256Bytes(`[${bytes}]`) === expectedSha) throw new Error(`${label} nesting passed`);
}

export function protocolSelfTest() {
  const v1 = { id: "case", variant: "tip", expectedValid: true, actualValid: true, resultHash: "rh", fixtureBefore: "fb", fixtureAfter: "fa", outcomeDigest: "od", server: null, effectHash: "ee" };
  const v2 = { version: 2, descriptorOrdinal: 7, id: "case", variant: "base", sourceSha: "sha", expectedValid: false, actualValid: false, components: { result: "rs", fixtureBefore: "fb", fixtureAfter: "fa", effectsBefore: "eb", effectsAfter: "ea", entry: "en", error: "er" } };
  assertEqual(canonicalBytes(v1), V1_GOLDEN_BYTES, "v1 canonical bytes");
  assertEqual(sha256Bytes(V1_GOLDEN_BYTES), V1_GOLDEN_SHA, "v1 SHA");
  assertEqual(canonicalBytes(v2), V2_GOLDEN_BYTES, "v2 canonical bytes");
  assertEqual(sha256Bytes(V2_GOLDEN_BYTES), V2_GOLDEN_SHA, "v2 SHA");
  assertMutationFails(V1_GOLDEN_BYTES, V1_GOLDEN_SHA, "v1");
  assertMutationFails(V2_GOLDEN_BYTES, V2_GOLDEN_SHA, "v2");
  if (digest([v1, { ...v1, id: "second" }]) === digest([{ ...v1, id: "second" }, v1])) throw new Error("record reorder passed");
  return { protocolVersion: PROTOCOL_VERSION, v1: V1_GOLDEN_SHA, v2: V2_GOLDEN_SHA };
}

export function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function sampleStats(samples) {
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  const first = percentile(samples.slice(0, 5), 0.5);
  const last = percentile(samples.slice(-5), 0.5);
  return { p50, p95, cv: Math.sqrt(variance) / mean, drift: Math.abs(last - first) / first };
}

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
