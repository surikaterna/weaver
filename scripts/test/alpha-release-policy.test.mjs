import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  expectedVersions, validateAlphaSelection, validatePackedDependencies,
  validatePublicationIntent,
} from '../alpha-release-validation.mjs';

const root = resolve(import.meta.dirname, '../..');
const base = 'cf0b6fe229b528a1eb809fd8f38c812f3636ca12';
const read = (path, tree = root) => readFileSync(resolve(tree, path), 'utf8');
const json = (path, tree = root) => JSON.parse(read(path, tree));
const original = (path) => execFileSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8' });
const changesetIds = readdirSync(resolve(root, '.changeset'))
  .filter((name) => name.endsWith('.md') && name !== 'README.md').map((name) => name.slice(0, -3)).sort();
const packagePaths = ['packages', 'apps'].flatMap((dir) => readdirSync(resolve(root, dir))
  .map((name) => `${dir}/${name}/package.json`));
const publicFixture = { name: '@weaver-conf/config-types', version: '0.2.0-alpha.0', private: false };

test('exact nine declarations change, all 19 bodies and other declarations remain verbatim', () => {
  const replacements = new Map([
    ['required-schema-admission', 2], ['schema-audit-boundary', 2],
    ['canonical-paths-register', 3], ['client-writes-server-authority', 1], ['path-first-client-flow', 1],
  ]);
  assert.equal(changesetIds.length, 19);
  for (const id of changesetIds) {
    const path = `.changeset/${id}.md`;
    const before = original(path);
    const count = replacements.get(id) ?? 0;
    assert.equal((before.match(/: major\n/g) ?? []).length, count);
    assert.equal(read(path), count ? before.replaceAll(': major\n', ': minor\n') : before);
  }
  assert.equal(read('.changeset/config.json'), original('.changeset/config.json'));
});

test('CLI alpha state preserves every source version without manual manifest or changelog edits', () => {
  const state = json('.changeset/pre.json');
  assert.equal(state.mode, 'pre');
  assert.equal(state.tag, 'alpha');
  assert.deepEqual(state.changesets, []);
  assert.equal(Object.keys(state.initialVersions).length, 16);
  for (const path of packagePaths) {
    const manifest = json(path);
    assert.equal(state.initialVersions[manifest.name], manifest.version);
    assert.equal(read(path), original(path));
    const changelog = path.replace('package.json', 'CHANGELOG.md');
    assert.equal(read(changelog), original(changelog));
  }
});

test('selection rejects stable, 1.x, non-alpha, unsafe tags, private and unknown packages', () => {
  validateAlphaSelection([publicFixture], 'alpha');
  for (const version of ['0.2.0', '1.0.0-alpha.0', '0.2.0-rc.0', '0.2.0-alpha', '0.2.0-alpha.01']) {
    assert.throws(() => validateAlphaSelection([{ ...publicFixture, version }], 'alpha'));
  }
  for (const tag of ['latest', 'next', '', undefined]) {
    assert.throws(() => validateAlphaSelection([publicFixture], tag));
  }
  for (const manifest of [{ ...publicFixture, private: true }, { ...publicFixture, name: '@weaver-conf/demo' },
    { ...publicFixture, name: 'unknown' }, { ...publicFixture, private: undefined }]) {
    assert.throws(() => validateAlphaSelection([manifest], 'alpha'));
  }
  assert.throws(() => validateAlphaSelection([], 'alpha'));
  assert.throws(() => validateAlphaSelection([publicFixture, publicFixture], 'alpha'));
});

test('stubbed publication argv requires explicit alpha and never runs a publisher', () => {
  validatePublicationIntent([publicFixture], 'pnpm', ['publish', '--tag', 'alpha', '--access', 'public', '--provenance']);
  for (const args of [ ['publish'], ['publish', '--tag', 'latest'], ['publish', '--tag', 'next'],
    ['changeset', 'publish'], ['publish', '--tag', 'alpha', '--tag=latest'],
    ['publish', '--tag', 'alpha', '-r'], ['publish', '--tag', 'alpha', '--filter=*'] ]) {
    assert.throws(() => validatePublicationIntent([publicFixture], 'pnpm', args));
  }
  assert.throws(() => validatePublicationIntent([publicFixture], 'npm', ['publish', '--tag', 'alpha']));
});

test('packed dependency validation rejects unresolved and incoherent internal specs', () => {
  validatePackedDependencies({ dependencies: { [publicFixture.name]: publicFixture.version } }, expectedVersions);
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const spec of ['workspace:*', 'link:../x', 'file:../x', '0.2.0', '^0.2.0-alpha.0']) {
      assert.throws(() => validatePackedDependencies({ [field]: { [publicFixture.name]: spec } }, expectedVersions));
    }
  }
});

test('disposable CLI version tree has exact targets, retained bodies and processed IDs', {
  skip: !process.env.ALPHA_VERSION_TREE,
}, () => {
  const tree = process.env.ALPHA_VERSION_TREE;
  const state = json('.changeset/pre.json', tree);
  assert.equal(state.mode, 'pre');
  assert.equal(state.tag, 'alpha');
  assert.deepEqual([...state.changesets].sort(), changesetIds);
  assert.deepEqual(state.initialVersions, json('.changeset/pre.json').initialVersions);
  assert.equal(packagePaths.length, 16);
  const publicManifests = [];
  for (const path of packagePaths) {
    const manifest = json(path, tree);
    assert.equal(manifest.version, expectedVersions[manifest.name]);
    if (!manifest.private) publicManifests.push({ ...manifest, private: false });
  }
  assert.equal(publicManifests.length, 14);
  validateAlphaSelection(publicManifests, 'alpha');
  for (const id of changesetIds) assert.equal(read(`.changeset/${id}.md`, tree), read(`.changeset/${id}.md`));
});

test('all 14 locally packed public manifests have registry-safe alpha dependencies', {
  skip: !process.env.ALPHA_PACK_DIR,
}, () => {
  const dir = process.env.ALPHA_PACK_DIR;
  const archives = readdirSync(dir).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 14);
  const manifests = archives.map((name) => JSON.parse(execFileSync('tar',
    ['-xOf', resolve(dir, name), 'package/package.json'], { encoding: 'utf8' })));
  validateAlphaSelection(manifests.map((manifest) => ({ ...manifest, private: manifest.private ?? false })), 'alpha');
  for (const manifest of manifests) {
    assert.equal(manifest.version, expectedVersions[manifest.name]);
    validatePackedDependencies(manifest, expectedVersions);
  }
});
