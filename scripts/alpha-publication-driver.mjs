import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  canonical, dependencyOrder, digest, inspectTar, makePlan, nativeProvenanceEvidence,
  parseInputs, publicVersions, registry, repository, requireCondition, validateManifest,
  validatePublisherOverrides, validateState, verifyPlan, workflow,
} from './alpha-publication-plan.mjs';
import { boundedBytes, boundedText, classify, mockRegistry, observeUpload, registryReader, unchanged } from './alpha-publication-registry.mjs';

const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, ...options });
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const git = (args) => run('git', args).trim();
export function validateGitContext(env, input, state) {
  requireCondition(env.GITHUB_REPOSITORY === repository && env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'Manual repository dispatch only');
  requireCondition(env.GITHUB_SERVER_URL === 'https://github.com' && env.GITHUB_ACTIONS === 'true', 'GitHub Actions context required');
  requireCondition(env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_WORKFLOW_REF === `${repository}/${workflow}@refs/heads/main`, 'Wrong workflow/ref');
  requireCondition([env.GITHUB_SHA, env.GITHUB_WORKFLOW_SHA, state.head, state.tip].every((sha) => sha === input.source_sha), 'Main/source/workflow drift');
  requireCondition(state.branch === 'main' && state.upstream === 'origin/main' && state.divergence === '0\t0' && state.clean, 'Clean attached main tracking origin/main required');
  requireCondition(state.origin === `https://github.com/${repository}.git`, 'Foreign origin');
}
export function checkGit(env, input, attach = false) {
  requireCondition(git(['remote', 'get-url', 'origin']) === `https://github.com/${repository}.git`, 'Foreign fetch origin');
  run('git', ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const head = git(['rev-parse', 'HEAD']);
  const tip = git(['rev-parse', 'origin/main']);
  requireCondition(head === input.source_sha && tip === head, 'Fresh main drift');
  if (attach) {
    requireCondition(git(['status', '--porcelain']) === '', 'Dirty checkout');
    run('git', ['checkout', '-B', 'main', head]);
    run('git', ['branch', '--set-upstream-to=origin/main', 'main']);
  }
  const state = { head, tip, origin: git(['remote', 'get-url', 'origin']), branch: git(['symbolic-ref', '--short', 'HEAD']),
    upstream: git(['rev-parse', '--abbrev-ref', '@{upstream}']), divergence: git(['rev-list', '--left-right', '--count', 'HEAD...origin/main']),
    clean: git(['status', '--porcelain']) === '' };
  validateGitContext(env, input, state);
  return { sha: head, tree: git(['rev-parse', 'HEAD^{tree}']) };
}
export function validateReadiness(environment, branches, evidence, sha, selected) {
  requireCondition(evidence?.ready === true && evidence.workflow_sha === sha && evidence.repository === repository, 'Admin readiness absent/stale');
  requireCondition(evidence.environment === 'npm-alpha' && evidence.authorization?.issue === 'weaver-hifc' &&
    evidence.authorization.source_sha === sha && evidence.authorization.approved === true &&
    typeof evidence.authorization.approver === 'string' && evidence.authorization.approver.length > 0, 'Separate publication authorization missing');
  const reviewers = environment.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  requireCondition(reviewers?.reviewers?.length > 0 && reviewers.prevent_self_review === true && environment.can_admins_bypass === false, 'Reviewer/self-review/admin-bypass protections unknown');
  requireCondition(reviewers.reviewers.every((entry) => ['User', 'Team'].includes(entry.type) &&
    Number.isSafeInteger(entry.reviewer?.id) && entry.reviewer.id > 0), 'Unknown required reviewer');
  requireCondition(environment.deployment_branch_policy?.custom_branch_policies === true &&
    environment.deployment_branch_policy.protected_branches === false, 'Custom main-only branch policy required');
  requireCondition(branches.total_count === 1 && branches.branch_policies?.length === 1 && branches.branch_policies[0].name === 'main' &&
    branches.branch_policies[0].type === 'branch', 'Main-only policy missing');
  requireCondition(evidence.protection_hash === digest(canonical({ environment, branches })), 'Admin protection evidence drift');
  requireCondition(canonical(evidence.authorization.packages) === canonical(selected), 'Authorization selection mismatch');
  requireCondition(selected.every((name) => evidence.trust?.[name]?.workflow === 'publish-alpha.yml' &&
    evidence.trust[name].environment === 'npm-alpha' && evidence.trust[name].repository === repository &&
    evidence.trust[name].direct_publish === true && evidence.trust[name].owner_verified === true), 'Per-package admin trust evidence missing');
}
export function safePublisherEnv(env, home) {
  requireCondition(isAbsolute(home), 'Absolute isolated config directory required');
  const names = ['PATH', 'GITHUB_ACTIONS', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_REPOSITORY', 'GITHUB_SERVER_URL',
    'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER_ID',
    'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'RUNNER_ENVIRONMENT', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
  return { ...Object.fromEntries(names.filter((key) => env[key] !== undefined).map((key) => [key, env[key]])),
    HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, CI: 'true',
    NPM_CONFIG_USERCONFIG: join(home, 'empty.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'empty.npmrc'),
    PNPM_CONFIG_FETCH_RETRIES: '0', NPM_CONFIG_FETCH_RETRIES: '0', COREPACK_ENABLE_NETWORK: '0' };
}
export function publishArgs(tarball) {
  requireCondition(isAbsolute(tarball) && tarball.endsWith('.tgz'), 'Absolute verified tarball required');
  return ['publish', tarball, '--tag', 'alpha', '--access', 'public', '--provenance', '--registry', registry];
}
export async function executePlan(plan, adapters) {
  const results = plan.packages.map((item) => ({ name: item.name, outcome: 'not-attempted' }));
  let index = 0;
  let uploadAttempted = false;
  try {
    await adapters.guard();
    for (const item of plan.packages) {
      await adapters.verifyTar(item);
      unchanged(item.status, await adapters.read(item.name, item.version));
    }
    for (const item of plan.packages) {
      await adapters.guard();
      await adapters.verifyTar(item);
      unchanged(item.status, await adapters.read(item.name, item.version));
      if (classify(item.status, item.integrity) === 'existing') {
        results[index++].outcome = 'verified-existing';
        continue;
      }
      await adapters.guard();
      uploadAttempted = true;
      await adapters.publish(item);
      results[index].accepted_upload = true;
      await observeUpload(adapters.read, item, adapters.sleep);
      results[index++].outcome = 'published';
      uploadAttempted = false;
    }
    return { success: true, results };
  } catch (error) {
    if (uploadAttempted && results[index]) results[index].outcome = 'failed-unknown';
    return { success: false, results, error: error.message };
  }
}
function sourceSnapshot(root) {
  const paths = ['packages', 'apps'].flatMap((dir) => readdirSync(join(root, dir))
    .map((name) => join(root, dir, name, 'package.json')).filter(existsSync));
  const manifests = paths.map(json);
  const state = json(join(root, '.changeset/pre.json'));
  const retained = readdirSync(join(root, '.changeset')).filter((name) => name.endsWith('.md') && name !== 'README.md').map((name) => name.slice(0, -3));
  const baseline = JSON.parse(run('git', ['show', '2ab7b06b0a4c518f765bfe28da6ca1bf7b9ce87f:.changeset/pre.json'], { cwd: root }));
  validateState(state, retained, manifests, baseline);
  return { manifests, versions: publicVersions(manifests), lock: digest(readFileSync(join(root, 'pnpm-lock.yaml'))),
    prestate: digest(readFileSync(join(root, '.changeset/pre.json'))) };
}
export function inspectDistribution(bytes) {
  const source = bytes.toString('utf8');
  requireCondition(source.includes('/libnpmpublish/11.2.0/') && source.includes('gitCommit: env3.GITHUB_SHA') &&
    source.includes('GIT_UNKNOWN_BRANCH') && source.includes('extractPublishManifestFromPacked'), 'Unreviewed native pnpm bundle');
  return { distribution_sha256: digest(bytes), native_libnpmpublish: '11.2.0' };
}
function toolEvidence() {
  const executable = process.env.PATH.split(delimiter).map((dir) => join(dir, 'pnpm')).find(existsSync);
  requireCondition(executable, 'pnpm distribution missing');
  const directory = dirname(realpathSync(executable));
  const bundle = [join(directory, '../dist/pnpm.mjs'), join(directory, '../pnpm/dist/pnpm.mjs')].find(existsSync);
  requireCondition(bundle, 'Direct provisioned pnpm required; no Corepack download/fallback in CI');
  const distribution = inspectDistribution(readFileSync(bundle));
  requireCondition(run('pnpm', ['--version']).trim() === '11.13.0', 'Pinned pnpm required');
  return { node: process.version, npm: run('npm', ['--version']).trim(), pnpm: '11.13.0',
    executable_sha256: digest(readFileSync(realpathSync(executable))), ...distribution,
    evidence_scope: 'Installed executable/native bundle bytes; not live OIDC or signature proof' };
}
export async function createLocalPlan(root, output, selected, context, read = mockRegistry(), tools = toolEvidence) {
  const snapshot = sourceSnapshot(root);
  const order = dependencyOrder(snapshot.manifests, selected);
  order.forEach((name) => validatePublisherOverrides(snapshot.manifests.find((manifest) => manifest.name === name)));
  mkdirSync(output, { recursive: true });
  const items = [];
  for (const name of order) {
    const slug = name.slice('@weaver-conf/'.length);
    run('pnpm', ['--filter', `./packages/${slug}`, 'pack', '--pack-destination', output], { cwd: root });
    const filename = `weaver-conf-${slug}-${snapshot.versions[name]}.tgz`;
    const bytes = readFileSync(join(output, filename));
    const { manifest, files } = inspectTar(bytes);
    validateManifest(manifest, snapshot.versions, files);
    const integrity = `sha512-${digest(bytes, 'sha512')}`;
    const status = await read(name, manifest.version);
    items.push({ name, version: manifest.version, filename, sha256: digest(bytes), integrity, manifest, files, status,
      intent: classify(status, integrity) === 'new' ? 'upload-alpha' : 'existing-no-retag' });
  }
  const plan = makePlan({ ...context, selected: [...selected].sort(), tools: tools(), lock: snapshot.lock, prestate: snapshot.prestate }, items);
  writeFileSync(join(output, 'plan.json'), canonical(plan));
  return plan;
}
function verifyTar(item, dir, versions) {
  requireCondition(/^weaver-conf-[a-z-]+-0\.\d+\.\d+-alpha\.\d+\.tgz$/.test(item.filename), 'Unsafe tar filename');
  const bytes = readFileSync(join(dir, item.filename));
  requireCondition(digest(bytes) === item.sha256 && `sha512-${digest(bytes, 'sha512')}` === item.integrity, 'Tar hash mismatch');
  const packed = inspectTar(bytes);
  validateManifest(packed.manifest, versions, packed.files);
  requireCondition(canonical(packed.manifest) === canonical(item.manifest) && canonical(packed.files) === canonical(item.files), 'Tar manifest/files mismatch');
}
async function github(path, env) {
  requireCondition(env.GH_READ_TOKEN, 'GitHub read credential missing');
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { method: 'GET', redirect: 'error',
    signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${env.GH_READ_TOKEN}`,
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  requireCondition(response.status === 200, 'GitHub evidence unavailable; publication blocked');
  return JSON.parse(await boundedText(response, 2 * 1024 * 1024));
}
export function validateArtifact(runInfo, artifact, input) {
  requireCondition(runInfo.id.toString() === input.plan_run_id && runInfo.repository?.full_name === repository && runInfo.repository.private === false &&
    runInfo.event === 'workflow_dispatch' && runInfo.head_branch === 'main' && runInfo.head_sha === input.source_sha &&
    runInfo.status === 'completed' && runInfo.conclusion === 'success' && runInfo.path === workflow, 'Invalid PLAN run');
  requireCondition(Number.isSafeInteger(artifact.id) && artifact.id > 0 && artifact.name === 'alpha-plan' && artifact.expired === false && artifact.workflow_run?.id === runInfo.id &&
    artifact.workflow_run.head_sha === input.source_sha && /^sha256:[a-f0-9]{64}$/.test(artifact.digest) &&
    artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 64 * 1024 * 1024, 'Invalid immutable artifact');
}
export function validateArchive(bytes, artifact, entries) {
  requireCondition(`sha256:${digest(bytes)}` === artifact.digest, 'Artifact digest mismatch');
  requireCondition(entries.length <= 15 && new Set(entries).size === entries.length && entries.includes('plan.json') &&
    entries.every((name) => name === 'plan.json' || /^weaver-conf-[a-z-]+-0\.\d+\.\d+-alpha\.\d+\.tgz$/.test(name)), 'Unsafe artifact entries');
}
async function downloadPlan(input, env, dir) {
  const runInfo = await github(`actions/runs/${input.plan_run_id}`, env);
  const listing = await github(`actions/runs/${input.plan_run_id}/artifacts?per_page=100`, env);
  requireCondition(listing.total_count === 1 && listing.artifacts?.length === 1, 'Ambiguous PLAN artifacts');
  const artifact = listing.artifacts[0];
  validateArtifact(runInfo, artifact, input);
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`, {
    redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${env.GH_READ_TOKEN}` } });
  requireCondition(response.status === 302, 'Artifact download unavailable');
  const url = new URL(response.headers.get('location'));
  requireCondition(url.protocol === 'https:' && /\.(?:blob\.core\.windows\.net|actions\.githubusercontent\.com)$/.test(url.hostname), 'Unexpected artifact host');
  const archive = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  requireCondition(archive.status === 200, 'Artifact expired/unreadable');
  const bytes = await boundedBytes(archive, 64 * 1024 * 1024);
  requireCondition(`sha256:${digest(bytes)}` === artifact.digest, 'Artifact digest mismatch');
  const zip = join(dir, 'artifact.zip');
  writeFileSync(zip, bytes);
  const entries = run('unzip', ['-Z1', zip]).trim().split('\n');
  validateArchive(bytes, artifact, entries);
  for (const name of entries) writeFileSync(join(dir, name), run('unzip', ['-p', zip, name], { encoding: 'buffer' }));
  const plan = json(join(dir, 'plan.json'));
  requireCondition(readFileSync(join(dir, 'plan.json'), 'utf8') === canonical(plan), 'Noncanonical plan bytes');
  requireCondition(canonical([...entries].sort()) === canonical(['plan.json', ...plan.packages.map((item) => item.filename)].sort()), 'Undeclared/missing artifact tarball');
  return { plan, runInfo, artifact };
}
function validateConfig(root) {
  requireCondition(!['.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs'].some((name) => existsSync(join(root, name))), 'Repository credential/hook config forbidden');
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  requireCondition(workspace === 'packages:\n  - "packages/*"\n  - "apps/*"\nallowBuilds:\n  esbuild: true\n', 'Unreviewed workspace publisher config');
}
function tempDirectory(env) {
  requireCondition(isAbsolute(env.RUNNER_TEMP ?? ''), 'Absolute RUNNER_TEMP required');
  const temp = realpathSync(env.RUNNER_TEMP);
  const root = realpathSync(process.cwd());
  requireCondition(temp !== root && !temp.startsWith(`${root}/`), 'External RUNNER_TEMP required');
  const dir = join(env.RUNNER_TEMP, `alpha-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`);
  requireCondition(!existsSync(dir), 'Reused publication scratch directory');
  mkdirSync(dir);
  return dir;
}
async function reviewedPlan(input, env, context, dir) {
  const { plan, runInfo, artifact } = await downloadPlan(input, env, dir);
  verifyPlan(plan, input, { ...context, attempt: String(runInfo.run_attempt) });
  requireCondition(plan.execution === 'github-main' && plan.run.url === runInfo.html_url && plan.lock === digest(readFileSync('pnpm-lock.yaml')) &&
    plan.prestate === digest(readFileSync('.changeset/pre.json')), 'PLAN source evidence mismatch');
  const snapshot = sourceSnapshot(process.cwd());
  requireCondition(canonical(dependencyOrder(plan.packages.map((item) => item.manifest), input.packages)) ===
    canonical(plan.packages.map((item) => item.name)), 'PLAN runtime order mismatch');
  for (const item of plan.packages) {
    verifyTar(item, dir, snapshot.versions);
    requireCondition(item.intent === (classify(item.status, item.integrity) === 'new' ? 'upload-alpha' : 'existing-no-retag'), 'PLAN upload/tag intent mismatch');
  }
  writeFileSync(env.GITHUB_STEP_SUMMARY, `Approved input hash ${input.plan_hash}\nSupplemental earlier PLAN build evidence, not authenticated historical build provenance.\n\`\`\`json\n${canonical(plan)}\n\`\`\`\n`, { flag: 'a' });
  return { plan, artifact, snapshot };
}
async function readinessGuard(input, env) {
  checkGit(env, input);
  validateConfig(process.cwd());
  const environment = await github('environments/npm-alpha', env);
  const branches = await github('environments/npm-alpha/deployment-branch-policies?per_page=100', env);
  validateReadiness(environment, branches, JSON.parse(env.ADMIN_EVIDENCE || 'null'), input.source_sha, input.packages);
  checkGit(env, input);
}
function upload(item, dir, env, home) {
  try {
    run('pnpm', publishArgs(join(dir, item.filename)), { env: safePublisherEnv(env, home), stdio: 'pipe' });
  } catch {
    throw new Error('Native upload failed/unknown; output withheld to avoid credential disclosure');
  }
}
async function privilegedPublish(input, env, context, dir) {
  const { plan, artifact, snapshot } = await reviewedPlan(input, env, context, dir);
  const guard = async () => {
    await readinessGuard(input, env);
  };
  await guard();
  requireCondition(canonical(toolEvidence()) === canonical(plan.tools), 'Tool distribution drift: new PLAN required');
  const home = join(dir, 'config');
  mkdirSync(home);
  writeFileSync(join(home, 'empty.npmrc'), '');
  const result = await executePlan(plan, { guard, read: registryReader(), sleep: () => new Promise((done) => setTimeout(done, 2000)),
    verifyTar: (item) => verifyTar(item, dir, snapshot.versions),
    publish: (item) => upload(item, dir, env, home) });
  const summary = { ...result, source_sha: context.sha, plan_run: plan.run, artifact_id: artifact.id, artifact_digest: artifact.digest,
    plan_hash: input.plan_hash, publish_run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT },
    expected_native_provenance: plan.packages.map((item) => nativeProvenanceEvidence(env, item.name, item.version, item.integrity)) };
  writeFileSync(join(dir, 'result.json'), canonical(summary));
  if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`, { flag: 'a' });
  requireCondition(result.success, 'Publication stopped; consult result.json and reconcile with a NEW plan');
}
async function main() {
  requireCondition(process.argv.length === 3, 'Exactly one internal command required');
  const command = process.argv[2];
  if (command === 'refuse') throw new Error('Legacy release disabled. PLAN/approval/admin readiness and separate weaver-hifc authorization required.');
  requireCondition(['prepare', 'plan', 'review', 'publish'].includes(command), 'Unknown command');
  const env = process.env;
  const input = parseInputs(JSON.parse(env.ALPHA_INPUTS || 'null'));
  requireCondition(input.mode === (command === 'review' ? 'publish' : command === 'prepare' ? 'plan' : command), 'Mode mismatch');
  requireCondition(env.RUNNER_ENVIRONMENT === 'github-hosted' && process.versions.node.split('.')[0] === '26', 'Hosted Node26 required');
  const context = checkGit(env, input, true);
  validateConfig(process.cwd());
  if (command === 'prepare') {
    const snapshot = sourceSnapshot(process.cwd());
    const order = dependencyOrder(snapshot.manifests, input.packages);
    order.forEach((name) => validatePublisherOverrides(snapshot.manifests.find((manifest) => manifest.name === name)));
    return;
  }
  const dir = tempDirectory(env);
  if (command === 'review') {
    await reviewedPlan(input, env, context, dir);
    return readinessGuard(input, env);
  }
  if (command === 'publish') return privilegedPublish(input, env, context, dir);
  const plan = await createLocalPlan(process.cwd(), dir, input.packages, { source_sha: context.sha, workflow_sha: context.sha,
    tree: context.tree, execution: 'github-main', run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
      url: `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}` } }, registryReader());
  checkGit(env, input);
  const hash = digest(canonical(plan));
  writeFileSync(env.GITHUB_OUTPUT, `artifact_path=${dir}\nplan_hash=${hash}\n`, { flag: 'a' });
  writeFileSync(env.GITHUB_STEP_SUMMARY, `PLAN ${hash}\nSupplemental build evidence only; no publication/OIDC.\n\`\`\`json\n${canonical(plan)}\n\`\`\`\n`, { flag: 'a' });
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(() => {
    console.error(process.argv[2] === 'refuse' ? 'Legacy release disabled: no build/publisher called. See the reviewed manual PLAN policy; publication needs separate authorization.' :
      'Alpha operation refused/stopped. No automatic retry. See validated plan/result evidence.');
    process.exitCode = 1;
  });
}
