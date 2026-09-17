import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBuiltinProviderFactories } from "../src/bootstrap/provider-resources.ts";
import { publicUpgradeCliError, publicUpgradeOutput } from "../src/cli-upgrade.ts";
import { buildUpgradeRoutes } from "../src/transport/rest-upgrade-routes.ts";

export function createProviderEffectObserver() {
  const state = { commits: [], created: 0, disposed: 0, subscriptions: 0 };
  const factories = new Map(
    [...createBuiltinProviderFactories()].map(([id, factory]) => [id, {
      ...factory,
      create: async (definition, context) => {
        const resource = await factory.create(definition, context);
        state.created++;
        observeProvider(resource.provider, definition.id, state);
        return observeDisposal(resource, state);
      },
    }]),
  );
  return {
    factories,
    checkpoint: () => snapshot(state),
    delta: (before) => difference(before, snapshot(state)),
    assertNoSubscriptions: () => assert.equal(state.subscriptions, 0),
    assertDisposed: () => assert.equal(state.disposed, state.created),
  };
}

export function assertExactFailureCommits(delta, journal, activationIntent = 0, activationCas = 0) {
  const steps = journal.steps.length;
  assert.deepEqual(delta.commits, {
    forwardData: steps,
    activationIntent,
    activationCas,
    activationCompletion: 0,
    failureJournal: 0,
    other: 4 + 2 * steps,
  });
}

export function assertExactDurableDeltas(
  before,
  after,
  journal,
  activationWrites = 0,
  receiptsMatch = true,
) {
  const steps = journal.steps.length;
  assert.equal(revisionDelta(before.control, after.control), BigInt(4 + 2 * steps + activationWrites));
  assert.equal(applicationDelta(before.application, after.application), BigInt(steps));
  assert.ok(journal.steps.every((step) => step.status === "complete"));
  assert.ok(journal.steps.every((step) => step.receipt));
  if (receiptsMatch)
    assert.ok(journal.steps.every((step) => step.receipt.operationId === step.operationId));
  assert.equal(journal.activation.status, activationWrites ? "intent" : "pending");
}

export function assertNoRecoveryCommits(delta) {
  assert.deepEqual(delta.commits, emptyCommits());
}

export async function durableFileSnapshot(fixture) {
  const paths = [...new Set([fixture.seed.store.locator.filePath,
    ...fixture.request.generation.providers.map((item) => item.options.filePath)])];
  return Promise.all(paths.map(async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return `missing:${path}`;
      throw error;
    }
  }));
}

export async function assertSanitizedSurfaces(runtime, error, forbidden = []) {
  const values = [{ code: error.code, message: error.message }, publicUpgradeCliError()];
  if (error.code === "COMMIT_OUTCOME_UNKNOWN")
    assert.deepEqual(error.details, {
      maintenanceCode: "unknown-commit",
      category: "uncertainty",
    });
  let status;
  let statusError;
  try {
    status = runtime.maintenanceStatus();
    const cliOutput = publicUpgradeOutput(status);
    assert.deepEqual(JSON.parse(cliOutput), status);
    values.push(status, cliOutput);
  } catch (surfaceError) {
    assert.equal(surfaceError.code, "COMMIT_OUTCOME_UNKNOWN");
    statusError = surfaceError;
  }
  const route = buildUpgradeRoutes(runtime).find((item) =>
    item.path === "/v1/admin/upgrades/status");
  assert.ok(route);
  let response;
  try {
    response = await route.handler({ authContext: { isAdmin: true } });
  } catch (surfaceError) {
    assert.equal(surfaceError.code, "COMMIT_OUTCOME_UNKNOWN");
  }
  assert.deepEqual(response, expectedStatusResponse(status, statusError));
  assert.deepEqual(response.headers, { "Content-Type": "application/json" });
  values.push(response.headers, response.body, response);
  for (const value of values) assertSurfaceValue(value, forbidden);
}

export function upgradePrivateFragments(fixture, journal, extra = []) {
  const generation = fixture.request.generation;
  const revisions = [journal.control?.revision, ...journal.sourceRevisions,
    ...journal.steps.flatMap((step) => [step.preRevision, step.receipt?.revision])];
  return [...new Set([
    fixture.directory,
    fixture.seed.store.locator.filePath,
    ...generation.providers.map((provider) => provider.options.filePath),
    fixture.seed.environment,
    fixture.request.generationId,
    ...generation.providers.map((provider) => provider.id),
    ...generation.layout.layers.map((layer) => layer.name),
    journal.planId,
    journal.nonce,
    journal.aggregateDigest,
    ...journal.steps.flatMap((step) => [step.operationId, step.receipt?.operationId,
      step.receipt?.mutationDigest]),
    ...journal.steps.map((step) => JSON.stringify(step.receipt)),
    ...revisions.filter(Boolean).map((revision) => JSON.stringify(revision)),
    JSON.stringify(journal.activation.finalContexts),
    JSON.stringify(journal),
    ...extra,
  ].filter((value) => typeof value === "string" && value.length > 1))];
}

export async function assertProductionCliSanitized(fixture, forbidden, credentials) {
  const seedPath = join(fixture.directory, "cli-seed.json");
  await writeFile(seedPath, JSON.stringify(fixture.seed), { mode: 0o600 });
  const result = await runBuiltCli(["upgrade-status", seedPath], {
    ...process.env,
    WEAVER_CREDENTIAL_administrator: credentials.administrator,
    WEAVER_CREDENTIAL_jwt: credentials.jwt,
    WEAVER_ADMIN_CREDENTIAL: credentials.administrator,
  });
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 1, signal: null });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${JSON.stringify(publicUpgradeCliError())}\n`);
  const parsed = JSON.parse(result.stderr);
  assert.deepEqual(parsed, publicUpgradeCliError());
  for (const value of [result.stdout, result.stderr, parsed])
    assertSurfaceValue(value, forbidden);
}

function expectedStatusResponse(status, error) {
  if (status) return {
    status: 200,
    body: { data: status },
    headers: { "Content-Type": "application/json" },
  };
  assert.equal(error.code, "COMMIT_OUTCOME_UNKNOWN");
  return {
    status: 503,
    body: { data: null, error: {
      code: "COMMIT_OUTCOME_UNKNOWN",
      message: "Upgrade outcome is uncertain; operator action is required",
    } },
    headers: { "Content-Type": "application/json" },
  };
}

async function runBuiltCli(args, environment) {
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [cli, ...args], {
    env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  assert.notEqual(result.signal, "SIGKILL", "production CLI exceeded its deadline");
  return result;
}

function observeProvider(provider, providerId, state) {
  if (provider.onExternalChange) {
    const subscribe = provider.onExternalChange.bind(provider);
    provider.onExternalChange = (...arguments_) => {
      state.subscriptions++;
      return subscribe(...arguments_);
    };
  }
  if (!provider.authority) return;
  const commit = provider.authority.commitLayer.bind(provider.authority);
  provider.authority.commitLayer = async (request, handle) => {
    const result = await commit(request, handle);
    if (result.success) state.commits.push(commitKind(providerId, request));
    return result;
  };
}

function observeDisposal(resource, state) {
  const dispose = resource.dispose.bind(resource);
  let disposed = false;
  return {
    ...resource,
    dispose: async () => {
      if (!disposed) {
        disposed = true;
        state.disposed++;
      }
      await dispose();
    },
  };
}

function commitKind(providerId, request) {
  if (providerId !== "control") return "forwardData";
  const value = request.mutation.action === "set" ? request.mutation.value : undefined;
  const journal = value?.activation
    ? value
    : request.mutation.key === "_weaver"
      ? Object.values(value?.upgrades?.journal ?? {})
        .find((item) => item.activation.status !== "pending")
      : undefined;
  if (journal?.failure) return "failureJournal";
  if (journal?.activation?.status === "complete") return "activationCompletion";
  if (journal?.activation?.status !== "intent") return "other";
  return request.operationId === journal.activation.operationId
    ? "activationCas"
    : "activationIntent";
}

function snapshot(state) {
  return {
    commits: countCommits(state.commits),
    created: state.created,
    disposed: state.disposed,
    subscriptions: state.subscriptions,
  };
}

function difference(before, after) {
  return {
    commits: Object.fromEntries(Object.entries(after.commits).map(
      ([kind, count]) => [kind, count - before.commits[kind]],
    )),
    created: after.created - before.created,
    disposed: after.disposed - before.disposed,
    subscriptions: after.subscriptions - before.subscriptions,
  };
}

function countCommits(records) {
  const result = emptyCommits();
  for (const kind of records) result[kind]++;
  return result;
}

function emptyCommits() {
  return {
    forwardData: 0,
    activationIntent: 0,
    activationCas: 0,
    activationCompletion: 0,
    failureJournal: 0,
    other: 0,
  };
}

function applicationDelta(before, after) {
  let total = 0n;
  for (const [providerId, envelopes] of Object.entries(after)) {
    for (const envelope of envelopes) {
      const prior = before[providerId].find((item) => item.layer === envelope.layer);
      total += revisionDelta(prior, envelope);
    }
  }
  return total;
}

function revisionDelta(before, after) {
  assert.deepEqual(
    [after.storeId, after.environment, after.layer, after.epoch],
    [before.storeId, before.environment, before.layer, before.epoch],
  );
  return BigInt(after.sequence) - BigInt(before.sequence);
}

function assertSurfaceValue(value, extra) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const strings = [serialized, ...nestedStrings(value)];
  for (const forbidden of ["finalContexts", "aggregateDigest", "storeId", "sequence",
    "journal", "receipt", "revision", "authority", "meta", "cache", "etag", "ETag",
    "mongodb://", "/tmp/", ...extra])
    assert.equal(strings.some((text) => text.includes(forbidden)), false, forbidden);
}

function nestedStrings(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) =>
    [key, ...nestedStrings(nested)]);
}
