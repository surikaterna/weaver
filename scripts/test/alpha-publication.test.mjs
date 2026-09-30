import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  allowlist, canonical, dependencyOrder, digest, inspectTar, makePlan, nativeProvenanceEvidence,
  parseInputs, publicVersions, repository, validateManifest, validatePublisherOverrides, validateState, verifyPlan, workflow,
} from '../alpha-publication-plan.mjs';
import { executePlan, inspectDistribution, publishArgs, safePublisherEnv, validateArchive, validateArtifact, validateGitContext, validateReadiness } from '../alpha-publication-driver.mjs';
import { boundedBytes, classify, mockRegistry, observeUpload, registryReader } from '../alpha-publication-registry.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const name = allowlist[0];
const version = '0.2.0-alpha.0';
const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
const manifest = { name, version, repository: { url: 'https://github.com/surikaterna/weaver.git' },
  files: ['dist'], main: './dist/index.cjs', module: './dist/index.js', types: './dist/index.d.ts',
  exports: { '.': { import: './dist/index.js', require: './dist/index.cjs', types: './dist/index.d.ts' } } };
const files = ['package.json', 'dist/index.js', 'dist/index.cjs', 'dist/index.d.ts'];
const versions = Object.fromEntries(allowlist.map((key) => [key, version]));
const manifests = allowlist.map((key) => ({ ...manifest, name: key }));
const selection = JSON.stringify([name]);
const inputs = { mode: 'publish', source_sha: sha, packages: selection, plan_run_id: '12', plan_hash: 'c'.repeat(64) };
inputs.confirmation = `PUBLISH ALPHA ${sha} ${inputs.plan_hash}`;
const env = { GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha,
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/heads/main`,
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '1' };
const gitState = { head: sha, tip: sha, branch: 'main', upstream: 'origin/main', divergence: '0\t0', clean: true,
  origin: `https://github.com/${repository}.git` };
const environment = { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }], prevent_self_review: true }],
  can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true, protected_branches: false } };
const branches = { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] };
const evidence = { ready: true, workflow_sha: sha, repository, environment: 'npm-alpha',
  protection_hash: digest(canonical({ environment, branches })),
  authorization: { issue: 'weaver-hifc', source_sha: sha, approved: true, approver: 'human-admin', packages: [name] },
  trust: { [name]: { workflow: 'publish-alpha.yml', environment: 'npm-alpha', repository, direct_publish: true, owner_verified: true } } };
const item = { name, version, integrity, status: { integrity: null, tags: { latest: '0.1.2' } } };

test('explicit all14 selection, private/unknown/duplicate/empty and injection inputs', () => {
  assert.equal(parseInputs({ mode: 'plan', source_sha: sha, packages: JSON.stringify(allowlist) }).packages.length, 14);
  for (const packages of ['[]', selection.replace(name, '@weaver-conf/demo'), '["unknown"]', JSON.stringify([name, name]), '$(touch /tmp/unsafe)', '{}']) {
    assert.throws(() => parseInputs({ mode: 'plan', source_sha: sha, packages }));
  }
  for (const bad of [{ source_sha: 'main' }, { source_sha: `${sha};x` }, { extra: 'x' }, { confirmation: 'yes' },
    { plan_run_id: '12;true' }, { plan_hash: 'latest' }, { mode: 'dry-run' }]) {
    assert.throws(() => parseInputs({ ...inputs, ...bad }));
  }
  assert.throws(() => parseInputs({ ...inputs, mode: 'plan' }));
});
test('public normalization is npm semantics, stable/private/incoherent states refused', () => {
  assert.equal(Object.keys(publicVersions(manifests)).length, 14);
  assert.throws(() => publicVersions([...manifests, manifest]), /Ambiguous/);
  for (const change of [{ private: true }, { private: 'false' }, { version: '1.0.0-alpha.0' },
    { version: '0.2.0' }, { version: '0.2.0-next.0' }, { version: '0.2.0-alpha.01' }]) {
    assert.throws(() => publicVersions([{ ...manifest, ...change }, ...manifests.slice(1)]));
  }
  const state = { mode: 'pre', tag: 'alpha', changesets: ['retained'], initialVersions: { [name]: '0.1.2' } };
  validateState(state, ['retained'], [manifest]);
  for (const change of [{ mode: 'post' }, { tag: 'latest' }, { changesets: [] }, { changesets: ['deleted'] },
    { changesets: ['retained', 'retained'] }, { initialVersions: {} }]) assert.throws(() => validateState({ ...state, ...change }, ['retained'], [manifest]));
  assert.throws(() => validateState({ ...state, changesets: ['new'] }, ['new', 'retained'], [manifest], state), /history reset/);
  assert.throws(() => validateState({ ...state, initialVersions: { [name]: '0.0.0' } }, ['retained'], [manifest], state), /history reset/);
});
test('runtime closure/optional peers required, deterministic dependency-first order and cycle rejection', () => {
  const second = { ...manifests[1], peerDependencies: { [name]: version }, peerDependenciesMeta: { [name]: { optional: true } } };
  assert.deepEqual(dependencyOrder([manifest, second], [second.name, name]), [name, second.name]);
  assert.throws(() => dependencyOrder([manifest, second], [second.name]));
  assert.throws(() => dependencyOrder([{ ...manifest, dependencies: { [second.name]: version } }, second], [name, second.name]));
  assert.throws(() => dependencyOrder([{ ...manifest, optionalDependencies: { '@weaver-conf/demo': version } }], [name]));
});
test('packed contracts reject unsafe refs, private Weaver deps, overrides, hooks and unexpected contents', () => {
  for (const entry of manifests) validateManifest(entry, versions, files);
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const spec of ['workspace:*', 'link:../x', 'file:../x', 'https://x/pkg.tgz', 'git+https://x', 'npm:other@1', '../x', '^0.2.0-alpha.0']) {
      assert.throws(() => validateManifest({ ...manifest, [field]: { [name]: spec } }, versions, files));
    }
    assert.throws(() => validateManifest({ ...manifest, [field]: { '@weaver-conf/private': version } }, versions, files));
  }
  for (const change of [{ repository: undefined }, { repository: { url: 'https://evil.test' } }, { publishConfig: { tag: 'latest' } },
    { publishConfig: { registry: 'https://elsewhere' } }, { publishConfig: { provenance: false } }, { tag: 'latest' }, { tag: 'next' }, { scripts: { prepare: 'anything' } },
    { main: './src/index.ts' }, { files: ['src'] }, { version: '0.1.0-alpha.0' }]) assert.throws(() => validateManifest({ ...manifest, ...change }, versions, files));
  assert.throws(() => validateManifest(manifest, versions, [...files, 'src/index.ts']));
  assert.throws(() => validateManifest(manifest, versions, files.slice(1)));
  assert.throws(() => validatePublisherOverrides({ ...manifest, scripts: { prepack: 'publisher hidden by pnpm obfuscation' } }));
});
function tarFixture(entries) {
  const parts = entries.flatMap(([path, content, type = '0']) => {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`package/${path}`, 0);
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.fill(32, 148, 156); header.write(type, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    return [header, body, Buffer.alloc((512 - body.length % 512) % 512)];
  });
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
test('actual tar parsing detects links, traversal, duplicate entries and tamper', () => {
  const entries = files.map((file) => [file, file === 'package.json' ? JSON.stringify(manifest) : 'output']);
  const bytes = tarFixture(entries);
  const packed = inspectTar(bytes);
  validateManifest(packed.manifest, versions, packed.files);
  assert.throws(() => inspectTar(tarFixture([...entries, ['../evil', 'x']])));
  assert.throws(() => inspectTar(tarFixture([...entries, ['dist/link.js', 'x', '2']])));
  assert.throws(() => inspectTar(tarFixture([...entries, entries[0]])));
  assert.throws(() => inspectTar(bytes.subarray(0, bytes.length - 5)));
});
test('canonical hash/plan selection/source/run/attempt binding rejects tampering and foreign evidence', () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  const plan = makePlan({ execution: 'github-main', source_sha: sha, workflow_sha: sha, tree, selected: [name], run: { id: '12', attempt: '2' } }, []);
  const input = { ...parseInputs(inputs), plan_hash: digest(canonical(plan)) };
  verifyPlan(plan, input, { sha, tree, attempt: '2' });
  for (const change of [{ execution: 'local-evidence' }, { repository: 'foreign/repo' }, { source_sha: 'd'.repeat(40) }, { tree: sha }, { selected: [] }, { run: { id: '13', attempt: '2' } }]) {
    assert.throws(() => verifyPlan({ ...plan, ...change }, input, { sha, tree, attempt: '2' }));
  }
  assert.throws(() => verifyPlan(plan, input, { sha, tree, attempt: '1' }));
});
test('same-SHA fresh main, genuine context and strict independent upstream/both-side guards', () => {
  validateGitContext(env, inputs, gitState);
  for (const change of [{ tip: 'd'.repeat(40) }, { head: 'd'.repeat(40) }, { branch: 'feature/x' }, { branch: null },
    { clean: false }, { upstream: '' }, { divergence: '1\t0' }, { divergence: '0\t1' }, { origin: 'https://github.com/foreign/repo.git' }]) {
    assert.throws(() => validateGitContext(env, inputs, { ...gitState, ...change }));
  }
  for (const change of [{ GITHUB_SHA: 'd'.repeat(40) }, { GITHUB_WORKFLOW_SHA: 'd'.repeat(40) },
    { GITHUB_REF: 'refs/tags/alpha' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_WORKFLOW_REF: 'other' }]) {
    assert.throws(() => validateGitContext({ ...env, ...change }, inputs, gitState));
  }
});
test('temporary Git fixture demonstrates attached main actual local origin 0/0 without publisher', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-git-'));
  const invoke = (args, cwd = dir) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    invoke(['init', '--bare', join(dir, 'origin.git')]); invoke(['clone', join(dir, 'origin.git'), join(dir, 'clone')]);
    const cwd = join(dir, 'clone');
    writeFileSync(join(cwd, 'proof'), 'fixture');
    invoke(['checkout', '-b', 'main'], cwd); invoke(['add', 'proof'], cwd);
    invoke(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'], cwd);
    invoke(['push', '-u', 'origin', 'main'], cwd); invoke(['fetch', 'origin', 'main'], cwd);
    assert.equal(invoke(['symbolic-ref', '--short', 'HEAD'], cwd), 'main');
    assert.equal(invoke(['rev-parse', '--abbrev-ref', '@{upstream}'], cwd), 'origin/main');
    assert.equal(invoke(['rev-list', '--left-right', '--count', 'HEAD...origin/main'], cwd), '0\t0');
    assert.equal(invoke(['status', '--porcelain'], cwd), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('readiness actual reviewer/main/admin policies + separately bound trust and authorization evidence', () => {
  validateReadiness(environment, branches, evidence, sha, [name]);
  for (const bad of [null, { ...evidence, ready: false }, { ...evidence, workflow_sha: tree }, { ...evidence, trust: {} },
    { ...evidence, authorization: { ...evidence.authorization, approved: false } }, { ...evidence, protection_hash: 'unknown' }]) {
    assert.throws(() => validateReadiness(environment, branches, bad, sha, [name]));
  }
  for (const change of [{ protection_rules: [] }, { can_admins_bypass: true }, { can_admins_bypass: undefined },
    { protection_rules: [{ ...environment.protection_rules[0], prevent_self_review: false }] }]) {
    assert.throws(() => validateReadiness({ ...environment, ...change }, branches, evidence, sha, [name]));
  }
  assert.throws(() => validateReadiness(environment, { branch_policies: [{ name: '*', type: 'branch' }] }, evidence, sha, [name]));
});
test('authenticated Actions run/artifact identity failures refuse foreign, expired, partial and uncertain artifacts', () => {
  const info = { id: 12, repository: { full_name: repository, private: false }, event: 'workflow_dispatch', head_branch: 'main', head_sha: sha,
    status: 'completed', conclusion: 'success', path: workflow };
  const artifact = { id: 123, name: 'alpha-plan', expired: false, workflow_run: { id: 12, head_sha: sha }, digest: `sha256:${'c'.repeat(64)}`, size_in_bytes: 100 };
  validateArtifact(info, artifact, inputs);
  for (const change of [{ conclusion: 'failure' }, { event: 'push' }, { head_sha: tree }, { head_branch: 'feature/x' },
    { id: 13 }, { repository: { full_name: 'other/repo' } }, { path: '.github/workflows/foreign.yml' }]) assert.throws(() => validateArtifact({ ...info, ...change }, artifact, inputs));
  for (const change of [{ expired: true }, { digest: null }, { size_in_bytes: 0 }, { name: 'other' }, { workflow_run: { id: 13, head_sha: sha } }]) assert.throws(() => validateArtifact(info, { ...artifact, ...change }, inputs));
});
test('immutable archive digest and flat entry allowlist reject changed bytes and path/shell payloads', () => {
  const bytes = Buffer.from('mock immutable ZIP bytes');
  const artifact = { digest: `sha256:${digest(bytes)}` };
  const entries = ['plan.json', 'weaver-conf-config-types-0.2.0-alpha.0.tgz'];
  validateArchive(bytes, artifact, entries);
  assert.throws(() => validateArchive(Buffer.from('tampered'), artifact, entries));
  for (const extra of ['../outside', 'dir/file', 'plan.json', '$(touch unsafe)', '-flag.tgz']) {
    assert.throws(() => validateArchive(bytes, artifact, [...entries, extra]));
  }
});
test('tar-only argv, sanitized fixed config, no tokens/proxies/bypass and unchanged native context', () => {
  const malicious = { ...env, PATH: '/trusted/bin', NODE_AUTH_TOKEN: 'secret', NPM_TOKEN: 'secret', NODE_OPTIONS: '--require evil',
    HTTPS_PROXY: 'http://evil', PNPM_CONFIG_GIT_CHECKS: 'false', NPM_CONFIG_REGISTRY: 'https://evil' };
  const safe = safePublisherEnv(malicious, '/tmp/isolated');
  assert.equal(safe.GITHUB_SHA, env.GITHUB_SHA); assert.equal(safe.GITHUB_WORKFLOW_REF, env.GITHUB_WORKFLOW_REF);
  for (const key of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NODE_OPTIONS', 'HTTPS_PROXY', 'PNPM_CONFIG_GIT_CHECKS', 'NPM_CONFIG_REGISTRY']) assert.equal(safe[key], undefined);
  assert.equal(safe.PNPM_CONFIG_FETCH_RETRIES, '0');
  assert.deepEqual(publishArgs('/tmp/verified.tgz'), ['publish', '/tmp/verified.tgz', '--tag', 'alpha', '--access', 'public', '--provenance', '--registry', 'https://registry.npmjs.org']);
  assert.throws(() => publishArgs('../unverified.tgz'));
  const proof = nativeProvenanceEvidence(safe, name, version, integrity);
  assert.equal(proof.source_sha, sha); assert.equal(proof.subject.digest.sha512, Buffer.alloc(64, 1).toString('hex'));
  assert.equal(proof.subject.name, 'pkg:npm/%40weaver-conf/config-types@0.2.0-alpha.0');
  assert.match(proof.publish_invocation, /runs\/99\/attempts\/1$/); assert.match(proof.claim, /supplemental/);
});
test('registry bounded GET, definitive404 and malformed/auth/rate-limit/errors deny uncertainty', async () => {
  const calls = [];
  const reader = registryReader(async (url, options) => { calls.push([url, options]); return new Response('', { status: 404 }); });
  assert.equal((await reader(name, version)).integrity, null);
  assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].headers.Authorization, undefined);
  for (const status of [401, 403, 429, 500]) await assert.rejects(registryReader(async () => new Response('', { status }))(name, version));
  await assert.rejects(registryReader(async () => new Response('not json', { status: 200 }))(name, version));
  await assert.rejects(registryReader(async () => { throw new Error('timeout'); })(name, version));
  await assert.rejects(boundedBytes(new Response('oversized'), 2), /too large/);
  const metadata = { name, versions: { [version]: { name, version, dist: { integrity } } }, 'dist-tags': { alpha: version, latest: '0.1.2' } };
  assert.equal((await registryReader(async () => new Response(JSON.stringify(metadata)))(name, version)).integrity, integrity);
  assert.equal(classify({ integrity }, integrity), 'existing'); assert.throws(() => classify({ integrity: 'conflict' }, integrity));
});
function executionAdapters(overrides = {}) {
  let published = false;
  const calls = { publish: 0, guard: 0, auth: 0 };
  return { calls, adapters: { guard: async () => { calls.guard++; }, verifyTar: async () => {},
    read: async () => published ? { integrity, tags: { latest: '0.1.2', alpha: version } } : structuredClone(item.status),
    publish: async () => { calls.publish++; calls.auth++; published = true; }, ...overrides } };
}
const invalidRegistryRecords = [
  null, false, 0, '', true, 1, 'record', [], [{ name, version, dist: { integrity } }], {},
  { name: 'wrong', version, dist: { integrity } }, { name, version: 'wrong', dist: { integrity } },
  { name, version }, ...[null, false, 0, '', [], 'dist', {}].map((dist) => ({ name, version, dist })),
  ...[null, false, 0, '', [], [integrity], 'sha1-invalid', 'sha512-short', `${integrity.slice(0, -3)}B==`]
    .map((value) => ({ name, version, dist: { integrity: value } })),
];
function metadataReader(versions, requestedVersion = version, tags = item.status.tags) {
  const read = registryReader(async () => new Response(JSON.stringify({ name, versions, 'dist-tags': tags })));
  return () => read(name, requestedVersion);
}
test('present malformed registry versions deny reader and early/late execution before any auth/upload', async () => {
  for (const record of invalidRegistryRecords) {
    const read = metadataReader({ [version]: record });
    await assert.rejects(read(), /registry/i);
    for (const failureRead of [1, 2]) {
      let reads = 0;
      const { calls, adapters } = executionAdapters({ read: () => ++reads === failureRead ? read() : metadataReader({})() });
      const result = await executePlan({ packages: [item] }, adapters);
      assert.equal(result.success, false); assert.equal(result.results[0].outcome, 'not-attempted');
      assert.equal(reads, failureRead); assert.equal(calls.auth, 0); assert.equal(calls.publish, 0);
    }
  }
});
test('valid missing own version/definitive404 remain absent; prototype versions do not count as records', async () => {
  assert.equal((await metadataReader({})()).integrity, null);
  assert.equal((await metadataReader({ other: null })()).integrity, null);
  assert.equal((await registryReader(async () => new Response('', { status: 404 }))(name, version)).integrity, null);
  for (const inherited of ['toString', 'constructor', '__proto__']) {
    assert.equal((await metadataReader({}, inherited)()).integrity, null);
  }
  assert.equal(Object.hasOwn(Object.prototype, version), false);
  Object.defineProperty(Object.prototype, version, { value: { name, version, dist: { integrity } }, configurable: true });
  try {
    assert.equal((await metadataReader({})()).integrity, null);
  } finally { delete Object.prototype[version]; }
  const read = metadataReader({ [version]: { name, version, dist: { integrity } } });
  assert.equal((await read()).integrity, integrity);
  const existing = { ...item, status: { integrity, tags: item.status.tags } };
  const { calls, adapters } = executionAdapters({ read });
  assert.equal((await executePlan({ packages: [existing] }, adapters)).results[0].outcome, 'verified-existing');
  assert.equal(calls.auth, 0); assert.equal(calls.publish, 0);
});
test('valid registry metadata with late tag drift still blocks upload and post-upload baseline drift fails', async () => {
  for (const tag of ['latest', 'next', 'alpha']) {
    let reads = 0;
    const changed = metadataReader({}, version, { ...item.status.tags, [tag]: 'changed' });
    const { calls, adapters } = executionAdapters({ read: () => ++reads === 2 ? changed() : metadataReader({})() });
    const result = await executePlan({ packages: [item] }, adapters);
    assert.equal(result.success, false); assert.match(result.error, /Registry drift/);
    assert.equal(calls.auth, 0); assert.equal(calls.publish, 0);
  }
  for (const tag of ['latest', 'next']) {
    const changed = metadataReader({ [version]: { name, version, dist: { integrity } } }, version,
      { ...item.status.tags, alpha: version, [tag]: 'changed' });
    await assert.rejects(observeUpload(changed, item), /latest\/next changed/);
  }
});
test('mock new uploads/no-history/stable/alpha histories, existing matching skips without retag', async () => {
  for (const tags of [{}, { latest: '0.1.2' }, { alpha: '0.1.3-alpha.0' }]) {
    let uploaded = false;
    const localItem = { ...item, status: { integrity: null, tags } };
    const { calls, adapters } = executionAdapters({ read: async () => ({ integrity: uploaded ? integrity : null,
      tags: uploaded ? { ...tags, alpha: version } : tags }), publish: async () => { calls.publish++; uploaded = true; } });
    assert.equal((await executePlan({ packages: [localItem] }, adapters)).results[0].outcome, 'published');
    assert.equal(calls.publish, 1);
  }
  const existing = { ...item, status: { integrity, tags: { alpha: 'other-alpha' } } };
  const { calls, adapters } = executionAdapters({ read: mockRegistry(existing.status) });
  assert.equal((await executePlan({ packages: [existing] }, adapters)).results[0].outcome, 'verified-existing');
  assert.equal(calls.publish, 0);
});
test('all readiness/Git/artifact/tar/API failures block BEFORE writes/auth; entire selection drift blocks', async () => {
  for (const message of ['reviewers absent', 'Git drift', 'artifact tamper', 'GitHub API inaccessible']) {
    const { calls, adapters } = executionAdapters({ guard: async () => { throw new Error(message); } });
    const result = await executePlan({ packages: [item] }, adapters);
    assert.equal(result.success, false); assert.equal(result.results[0].outcome, 'not-attempted');
    assert.equal(calls.auth, 0); assert.equal(calls.publish, 0);
  }
  for (const overrides of [{ verifyTar: async () => { throw new Error('tar tamper'); } },
    { read: async () => ({ integrity: 'conflict', tags: {} }) }, { read: async () => { throw new Error('401'); } }]) {
    const { calls, adapters } = executionAdapters(overrides);
    assert.equal((await executePlan({ packages: [item] }, adapters)).success, false); assert.equal(calls.publish, 0);
  }
});
test('visibility lag bounded, ambiguous/auth failures stop once, main advancement stops partial release', async () => {
  let reads = 0;
  const observed = await observeUpload(async () => ++reads === 3 ? { integrity, tags: { latest: '0.1.2', alpha: version } } : item.status, item);
  assert.equal(observed.integrity, integrity); assert.equal(reads, 3);
  await assert.rejects(observeUpload(mockRegistry(item.status), item), /visibility unknown/);
  const second = { ...item, name: allowlist[1] };
  const failing = executionAdapters({ publish: async () => { failing.calls.publish++; throw new Error('accepted? auth? timeout?'); } });
  const result = await executePlan({ packages: [item, second] }, failing.adapters);
  assert.deepEqual(result.results.map((entry) => entry.outcome), ['failed-unknown', 'not-attempted']); assert.equal(failing.calls.publish, 1);
  const partial = executionAdapters();
  partial.adapters.guard = async () => { if (++partial.calls.guard === 4) throw new Error('fresh main advanced'); };
  const stopped = await executePlan({ packages: [item, second] }, partial.adapters);
  assert.deepEqual(stopped.results.map((entry) => entry.outcome), ['published', 'not-attempted']); assert.equal(partial.calls.publish, 1);
  const retry = executionAdapters({ read: mockRegistry({ integrity, tags: { latest: '0.1.2', alpha: version } }) });
  const reconciled = { ...item, status: { integrity, tags: { latest: '0.1.2', alpha: version } } };
  assert.equal((await executePlan({ packages: [reconciled] }, retry.adapters)).results[0].outcome, 'verified-existing'); assert.equal(retry.calls.publish, 0);
});
test('legacy root release refuses nonzero with no package manager/build/Git calls from driver', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-refusal-'));
  try {
    for (const executable of ['pnpm', 'npm', 'turbo', 'git', 'changeset']) writeFileSync(join(dir, executable), `#!/bin/sh\n: > '${join(dir, 'called')}'\nexit 99\n`, { mode: 0o755 });
    assert.throws(() => execFileSync(process.execPath, [join(root, 'scripts/alpha-publication-driver.mjs'), 'refuse'],
      { env: { ...process.env, PATH: dir }, stdio: 'pipe' }));
    assert.equal(existsSync(join(dir, 'called')), false);
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.release, 'node scripts/alpha-publication-driver.mjs refuse');
    assert.throws(() => execFileSync('pnpm', ['run', 'release'], { cwd: root, stdio: 'pipe' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('provisioned native distribution inspection rejects shim/unreviewed implementation', () => {
  const bytes = Buffer.from('/libnpmpublish/11.2.0/ gitCommit: env3.GITHUB_SHA GIT_UNKNOWN_BRANCH extractPublishManifestFromPacked');
  assert.equal(inspectDistribution(bytes).distribution_sha256, digest(bytes));
  assert.throws(() => inspectDistribution(Buffer.from('Corepack shim or unrelated pnpm implementation')));
});
test('actual all14 local packs are byte-validated; two missing identities are blocked, never patched', {
  skip: !process.env.ALPHA_PACK_DIR,
}, () => {
  const dir = process.env.ALPHA_PACK_DIR;
  const blocked = [];
  for (const packageName of allowlist) {
    const slug = packageName.slice('@weaver-conf/'.length);
    const source = JSON.parse(readFileSync(join(root, 'packages', slug, 'package.json'), 'utf8'));
    const bytes = readFileSync(join(dir, `weaver-conf-${slug}-${source.version}.tgz`));
    const packed = inspectTar(bytes);
    assert.equal(packed.manifest.name, source.name); assert.equal(packed.manifest.version, source.version);
    const sourceVersions = Object.fromEntries(allowlist.map((key) => [key,
      JSON.parse(readFileSync(join(root, 'packages', key.slice('@weaver-conf/'.length), 'package.json'), 'utf8')).version]));
    if (source.repository?.url) validateManifest(packed.manifest, sourceVersions, packed.files);
    else {
      assert.throws(() => validateManifest(packed.manifest, sourceVersions, packed.files), /Repository identity/);
      blocked.push(source.name);
    }
  }
  assert.deepEqual(blocked.sort(), ['@weaver-conf/config-runtime', '@weaver-conf/storage-providers']);
});
test('actual local PLAN fixture binds exact packed manifests/SRI/hash, but cannot become publish approval', {
  skip: !process.env.ALPHA_LOCAL_PLAN,
}, () => {
  const path = process.env.ALPHA_LOCAL_PLAN;
  const text = readFileSync(path, 'utf8');
  const plan = JSON.parse(text);
  assert.equal(text, canonical(plan)); assert.equal(plan.execution, 'local-evidence');
  for (const entry of plan.packages) {
    const bytes = readFileSync(join(resolve(path, '..'), entry.filename));
    assert.equal(digest(bytes), entry.sha256); assert.equal(`sha512-${digest(bytes, 'sha512')}`, entry.integrity);
    assert.deepEqual(inspectTar(bytes).manifest, entry.manifest); assert.equal(entry.intent, 'upload-alpha');
  }
  const localInput = { ...inputs, plan_hash: digest(text), source_sha: plan.source_sha, packages: plan.selected };
  assert.throws(() => verifyPlan(plan, localInput, { sha: plan.source_sha, tree: plan.tree, attempt: plan.run.attempt }), /Local evidence/);
});
