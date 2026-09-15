import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  let status;
  try {
    status = runtime.maintenanceStatus();
    values.push(status, publicUpgradeOutput(status));
  } catch (surfaceError) {
    assert.equal(surfaceError.code, "COMMIT_OUTCOME_UNKNOWN");
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
  if (response) {
    assert.equal(response.status, status ? 200 : 503);
    assert.equal(response.headers?.etag, undefined);
    assert.equal(response.headers?.ETag, undefined);
    assert.equal(response.body.meta, undefined);
    values.push(response.body);
  }
  for (const value of values) assertSurfaceValue(value, forbidden);
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
  const serialized = JSON.stringify(value);
  for (const forbidden of ["finalContexts", "aggregateDigest", "storeId", "sequence",
    "journal", "receipt", "revision", "mongodb://", "/tmp/", ...extra])
    assert.equal(serialized.includes(forbidden), false, forbidden);
}
