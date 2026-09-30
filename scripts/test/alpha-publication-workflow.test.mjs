import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');
const yaml = read('.github/workflows/publish-alpha.yml');
const plan = yaml.split('  plan:\n')[1].split('  review:\n')[0];
const review = yaml.split('  review:\n')[1].split('  publish:\n')[0];
const publish = yaml.split('  publish:\n')[1];
const driver = read('scripts/alpha-publication-driver.mjs');
test('manual dispatch-only, default PLAN/noOIDC, explicit JSON/source and no shell interpolation', () => {
  assert.match(yaml, /on:\n {2}workflow_dispatch:/);
  assert.doesNotMatch(yaml, /^\s+(?:push|pull_request|workflow_run|workflow_call|schedule|tags):/m);
  assert.match(yaml, /options: \[plan, publish\]\n {8}default: plan/);
  assert.doesNotMatch(plan, /id-token|GH_READ_TOKEN|ADMIN_EVIDENCE|publish --|driver\.mjs publish|dry-run/);
  assert.match(yaml, /ALPHA_INPUTS: \$\{\{ toJSON\(inputs\) \}\}/);
  for (const line of yaml.split('\n').filter((line) => line.includes('run:'))) assert.doesNotMatch(line, /\$\{\{/);
  assert.match(driver, /PUBLISH ALPHA|parseInputs/);
});
test('protected publish review first, least privilege and fixed serialization; no package lifecycle/build/install', () => {
  assert.match(publish, /needs: review/); assert.match(publish, /environment: npm-alpha/);
  assert.match(publish, /id-token: write/); assert.doesNotMatch(review, /id-token/);
  assert.equal((yaml.match(/id-token: write/g) ?? []).length, 1);
  assert.match(yaml, /group: surikaterna-weaver-npm-alpha\n {2}cancel-in-progress: false/);
  assert.doesNotMatch(publish, /run:.*(?:install|build|test|pack|changeset)/);
  assert.doesNotMatch(yaml, /contents: write|packages: write|pull-requests: write|NODE_AUTH_TOKEN|NPM_TOKEN|registry-url/);
  assert.match(publish, /run_install: false/); assert.match(publish, /ADMIN_EVIDENCE: \$\{\{ vars.ALPHA_ADMIN_EVIDENCE \}\}/);
  for (const job of [plan, review, publish]) assert.match(job, /github\.repository == 'surikaterna\/weaver'.*github\.ref == 'refs\/heads\/main'/);
});
test('every action immutable-pinned, checkout immutable/full/persist false, no context/bypass/worktree escape', () => {
  for (const line of yaml.split('\n').filter((line) => line.includes('uses:'))) assert.match(line, /uses: [\w/-]+@[a-f0-9]{40} #/);
  assert.equal((yaml.match(/persist-credentials: false/g) ?? []).length, 3);
  assert.equal((yaml.match(/fetch-depth: 0/g) ?? []).length, 3);
  assert.equal((yaml.match(/ref: \$\{\{ github.sha \}\}/g) ?? []).length, 3);
  assert.match(driver, /branch', '--set-upstream-to=origin\/main'/);
  assert.match(driver, /rev-list', '--left-right', '--count', 'HEAD\.\.\.origin\/main'/);
  assert.match(driver, /git', \['fetch', '--no-tags', 'origin'/);
  assert.doesNotMatch(driver, /--no-git-checks|gitChecks: false|GITHUB_SHA\s*=|provenance-file|shell:|process\.chdir/);
  assert.match(driver, /External RUNNER_TEMP required/);
});
test('PLAN forced root gates/localpack only; immutable artifact identity and independent native semantics', () => {
  for (const gate of ['build', 'typecheck', 'lint', 'test']) assert.match(plan, new RegExp(`run: pnpm run ${gate} --force`));
  assert.match(plan, /name: alpha-plan/); assert.match(plan, /if-no-files-found: error/);
  assert.match(driver, /artifact.digest/); assert.match(driver, /runInfo.run_attempt/);
  assert.match(driver, /plan\.execution === 'github-main'/);
  assert.match(driver, /await guard\(\)/);
  assert.match(driver, /safePublisherEnv\(env, home\)/);
  assert.match(driver, /supplemental|Supplemental/);
});
test('historical evidence validator and PR-only workflow byte-identical to approved base; no extra tracked scope', () => {
  for (const file of ['scripts/alpha-release-validation.mjs', '.github/workflows/publish.yml']) {
    const before = execFileSync('git', ['show', `2ab7b06:${file}`], { cwd: root, encoding: 'utf8' });
    assert.equal(read(file), before);
  }
});
