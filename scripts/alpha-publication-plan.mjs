import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { validateAlphaSelection, validatePackedDependencies } from './alpha-release-validation.mjs';

export const repository = 'surikaterna/weaver';
export const registry = 'https://registry.npmjs.org';
export const workflow = '.github/workflows/publish-alpha.yml';
export const allowlist = Object.freeze([
  'config-types', 'config-engine', 'config-auth', 'config-policy', 'config-runtime',
  'config-secrets', 'config-sessions', 'config-sync', 'storage-provider-local-storage',
  'storage-provider-static-json', 'storage-providers', 'transport-scomp', 'weaver-client', 'weaver-server',
].map((name) => `@weaver-conf/${name}`));
const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const hooks = ['prepublishOnly', 'prepublish', 'prepare', 'prepack', 'postpack', 'publish', 'postpublish'];
export function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
export function exactKeys(value, keys) {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  requireCondition(Object.keys(value).every((key) => keys.includes(key)), 'Unknown field');
}
export function digest(bytes, algorithm = 'sha256') {
  return createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  requireCondition(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'Non-JSON value');
  return JSON.stringify(value);
}
export function parseInputs(value) {
  exactKeys(value, ['mode', 'source_sha', 'packages', 'plan_run_id', 'plan_hash', 'confirmation']);
  requireCondition(['plan', 'publish'].includes(value.mode), 'Invalid mode');
  requireCondition(/^[a-f0-9]{40}$/.test(value.source_sha), 'Full source SHA required');
  const packages = JSON.parse(value.packages);
  requireCondition(Array.isArray(packages) && packages.length > 0, 'Explicit selection required');
  requireCondition(packages.every((name) => allowlist.includes(name)), 'Unknown/private package');
  requireCondition(new Set(packages).size === packages.length, 'Duplicate selection');
  if (value.mode === 'publish') validateConfirmation(value);
  else requireCondition(!value.plan_run_id && !value.plan_hash && !value.confirmation, 'Publish inputs in PLAN');
  return { ...value, packages: [...packages].sort() };
}
function validateConfirmation(value) {
  requireCondition(/^[1-9]\d*$/.test(value.plan_run_id), 'PLAN run ID required');
  requireCondition(/^[a-f0-9]{64}$/.test(value.plan_hash), 'PLAN hash required');
  requireCondition(value.confirmation === `PUBLISH ALPHA ${value.source_sha} ${value.plan_hash}`, 'Confirmation mismatch');
}
export function validateState(state, retained, manifests, baseline = state) {
  requireCondition(state.mode === 'pre' && state.tag === 'alpha', 'Alpha prerelease state required');
  requireCondition(Array.isArray(state.changesets) && state.changesets.length > 0, 'Processed prerelease IDs required');
  requireCondition(new Set(state.changesets).size === state.changesets.length, 'Duplicate prerelease IDs');
  requireCondition(state.changesets.every((id) => retained.includes(id)), 'Processed changeset removed');
  requireCondition(Object.keys(state.initialVersions ?? {}).length === manifests.length, 'Initial versions incomplete');
  requireCondition(manifests.every((manifest) => typeof state.initialVersions[manifest.name] === 'string'), 'Initial version missing');
  requireCondition(canonical(state.initialVersions) === canonical(baseline.initialVersions) &&
    baseline.changesets.every((id) => state.changesets.includes(id)), 'Prerelease history reset/initial versions changed');
}
export function publicVersions(manifests) {
  requireCondition(new Set(manifests.map((manifest) => manifest.name)).size === manifests.length, 'Ambiguous source package identity');
  const publicManifests = allowlist.map((name) => manifests.find((manifest) => manifest.name === name));
  requireCondition(publicManifests.every(Boolean), 'Source allowlist incomplete');
  // npm treats an absent private flag as public; normalize only this domain value, never the tar bytes.
  validateAlphaSelection(publicManifests.map((manifest) => ({ ...manifest, private: manifest.private === undefined ? false : manifest.private })), 'alpha');
  return Object.fromEntries(publicManifests.map((manifest) => [manifest.name, manifest.version]));
}
export function validateManifest(manifest, versions, files) {
  requireCondition(allowlist.includes(manifest.name), 'Not allowlisted');
  validateAlphaSelection([{ ...manifest, private: manifest.private === undefined ? false : manifest.private }], 'alpha');
  requireCondition(manifest.version === versions[manifest.name], 'Source version mismatch');
  requireCondition(manifest.repository?.url === 'https://github.com/surikaterna/weaver.git', 'Repository identity missing/mismatched');
  validatePublisherOverrides(manifest);
  validatePackedDependencies(manifest, versions);
  for (const field of fields) validateRefs(manifest[field] ?? {}, versions);
  requireCondition(JSON.stringify(manifest.files) === '["dist"]', 'Expected dist-only files');
  requireCondition(files.every((file) => /^(?:dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:js|cjs|d\.ts|d\.cts)|package.json|README(?:\.md)?|LICENSE(?:\.md)?|CHANGELOG\.md)$/.test(file) && !file.includes('/src/')), 'Unexpected packed file');
  requireCondition(files.includes('package.json') && files.includes('dist/index.js') && files.includes('dist/index.cjs') && files.includes('dist/index.d.ts'), 'Missing dist outputs');
  for (const target of exportTargets(manifest.exports)) validateTarget(target, files);
  for (const target of [manifest.main, manifest.module, manifest.types, ...Object.values(manifest.bin ?? {})]) validateTarget(target, files);
}
export function validatePublisherOverrides(manifest) {
  const config = manifest.publishConfig;
  requireCondition(config === undefined || (config && typeof config === 'object' && !Array.isArray(config) && Object.keys(config).length === 0), 'publishConfig override forbidden');
  requireCondition(!Object.hasOwn(manifest, 'tag'), 'Manifest tag override forbidden');
  requireCondition(hooks.every((hook) => !Object.hasOwn(manifest.scripts ?? {}, hook)), 'Publish lifecycle forbidden');
}
function validateRefs(refs, versions) {
  for (const [name, spec] of Object.entries(refs)) {
    requireCondition(typeof spec === 'string' && /^[~^<>=*\d][\dA-Za-z.+~^<>=*| -]*$/.test(spec), 'Non-registry dependency');
    if (!name.startsWith('@weaver-conf/')) continue;
    requireCondition(Object.hasOwn(versions, name) && spec === versions[name], 'Unknown/private/incoherent internal dependency');
  }
}
function exportTargets(value) {
  if (typeof value === 'string') return [value];
  requireCondition(value && typeof value === 'object', 'Missing exports');
  return Object.values(value).flatMap(exportTargets);
}
function validateTarget(target, files) {
  requireCondition(typeof target === 'string' && target.startsWith('./dist/'), 'Non-dist export');
  if (target.includes('*')) {
    requireCondition(/^\.\/dist\/[A-Za-z0-9_/-]+\/\*\.(?:js|cjs|d\.ts)$/.test(target), 'Unsafe export pattern');
    return;
  }
  requireCondition(files.includes(target.slice(2)), 'Export target missing');
}
export function dependencyOrder(manifests, selected) {
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const visiting = new Set();
  const done = new Set();
  const result = [];
  function visit(name) {
    requireCondition(!visiting.has(name), 'Runtime dependency cycle');
    if (done.has(name)) return;
    requireCondition(selected.includes(name), 'Missing explicit runtime closure');
    visiting.add(name);
    const manifest = byName.get(name);
    requireCondition(manifest, 'Missing selected manifest');
    const deps = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    Object.keys(deps).filter((dep) => dep.startsWith('@weaver-conf/')).sort().forEach(visit);
    visiting.delete(name);
    done.add(name);
    result.push(name);
  }
  [...selected].sort().forEach(visit);
  return result;
}
export function inspectTar(bytes) {
  requireCondition(bytes.length <= 32 * 1024 * 1024, 'Archive too large');
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      requireCondition(tar.subarray(offset).every((byte) => byte === 0), 'Hidden trailing tar entries');
      break;
    }
    const name = tarString(header.subarray(0, 100));
    requireCondition(!tarString(header.subarray(345, 500)), 'Extended tar path forbidden');
    const stored = tarNumber(header.subarray(148, 156));
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    requireCondition(stored === checksum, 'Invalid tar checksum');
    const size = tarNumber(header.subarray(124, 136));
    requireCondition(name.startsWith('package/') && !name.split('/').some((part) => part === '..' || part === '.'), 'Unsafe tar path');
    requireCondition([0, 48].includes(header[156]) && !entries.has(name.slice(8)), 'Tar links/extensions/duplicates forbidden');
    requireCondition(offset + 512 + size <= tar.length, 'Truncated tar');
    entries.set(name.slice(8), tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  requireCondition(entries.has('package.json'), 'Manifest missing');
  return { manifest: JSON.parse(entries.get('package.json').toString('utf8')), files: [...entries.keys()].sort() };
}
function tarString(bytes) { return bytes.toString('utf8').split('\0')[0]; }
function tarNumber(bytes) {
  const value = tarString(bytes).trim();
  requireCondition(/^[0-7]+$/.test(value), 'Invalid tar number');
  return Number.parseInt(value, 8);
}
export function makePlan(context, packages) {
  return { schema: 1, repository, registry, workflow, ...context, packages };
}
export function verifyPlan(plan, input, context) {
  requireCondition(plan.schema === 1 && plan.repository === repository && plan.registry === registry && plan.workflow === workflow, 'Foreign plan');
  requireCondition(plan.execution === 'github-main', 'Local evidence is not an eligible Actions plan');
  requireCondition(input.source_sha === context.sha && plan.source_sha === plan.workflow_sha, 'Distinct source/workflow SHA forbidden');
  requireCondition(digest(canonical(plan)) === input.plan_hash, 'Plan hash mismatch');
  requireCondition(plan.source_sha === input.source_sha && plan.workflow_sha === context.sha && plan.tree === context.tree, 'Plan commit mismatch');
  requireCondition(plan.run.id === input.plan_run_id && plan.run.attempt === context.attempt, 'Plan run/attempt mismatch');
  requireCondition(canonical(plan.selected) === canonical(input.packages), 'Plan selection mismatch');
}
export function nativeProvenanceEvidence(env, name, version, integrity) {
  requireCondition(/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity), 'Expected sha512 SRI');
  return { subject: { name: `pkg:npm/${name.replace(/^@/, '%40')}@${version}`,
    digest: { sha512: Buffer.from(integrity.slice(7), 'base64').toString('hex') } }, source_sha: env.GITHUB_SHA,
    workflow_ref: env.GITHUB_WORKFLOW_REF,
    publish_invocation: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
    evidence: 'Expected payload model only; live signature/OIDC proof not verified here',
    claim: 'Native PUBLISH-run/commit provenance; earlier PLAN build is supplemental hash-bound evidence only' };
}
