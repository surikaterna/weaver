import assert from "node:assert/strict";
import { createBuiltinProviderFactories } from "../src/bootstrap/provider-resources.ts";
import { hostForControl } from "../src/core/config-service-internal.ts";

export function newCounters() {
  return {
    reverseEffects: 0,
    intents: new Set(),
    completions: new Set(),
    otherJournal: new Set(),
    reverseOrder: [],
    opens: 0,
    closes: 0,
    resourcesCreated: 0,
    resourcesDisposed: 0,
    providerSubscriptions: 0,
    providerSubscriptionDisposals: 0,
    publicSubscriptions: 0,
    publicSubscriptionDisposals: 0,
    publicEvents: 0,
    openAttempts: 0,
  };
}

export function countingFactories(counters) {
  return new Map(
    [...createBuiltinProviderFactories()].map(([id, factory]) => [
      id,
      {
        ...factory,
        create: async (definition, context) => {
          const resource = await factory.create(definition, context);
          counters.resourcesCreated++;
          instrumentProvider(resource.provider, counters);
          return instrumentResource(resource, counters);
        },
      },
    ]),
  );
}

export function observeRuntime(t, runtime, counters, recordCommit) {
  const host = hostForControl(runtime.configService);
  const unsubscribe = host.runtime.onDelta(
    () => counters.publicEvents++,
  );
  counters.publicSubscriptions++;
  if (recordCommit) countRuntimeWrites(t, runtime, recordCommit);
  let closed = false;
  return {
    snapshot: () => ({
      revision: host.authority.revision(),
      events: counters.publicEvents,
      subscriptions: counters.publicSubscriptions,
      providerSubscriptions: counters.providerSubscriptions,
    }),
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      counters.publicSubscriptionDisposals++;
    },
  };
}

export function assertNoPublication(observation, before, allowRevision) {
  const after = observation.snapshot();
  assert.equal(after.events, before.events);
  assert.equal(after.subscriptions, before.subscriptions);
  assert.equal(after.providerSubscriptions, before.providerSubscriptions);
  if (!allowRevision) assert.equal(after.revision, before.revision);
}

export function assertLifecycle(run, counters) {
  assertNoLifecycleLeaks(run, counters);
  assert.equal(counters.publicSubscriptions, counters.opens);
  assert.equal(counters.publicSubscriptionDisposals, counters.opens);
  assert.equal(
    counters.resourcesCreated,
    run.lifecycle.resourcesPerOpen * counters.opens,
  );
  assert.equal(
    counters.providerSubscriptions,
    run.lifecycle.providerSubscriptionsPerOpen * counters.opens,
  );
}

export function assertNoLifecycleLeaks(run, counters) {
  assert.equal(counters.opens, counters.closes);
  assert.equal(counters.publicSubscriptionDisposals, counters.publicSubscriptions);
  assert.equal(counters.resourcesDisposed, counters.resourcesCreated);
  assert.equal(
    counters.providerSubscriptionDisposals,
    counters.providerSubscriptions,
  );
  assert.equal(counters.publicEvents, run.lifecycle.expectedPublicEvents);
}

function countRuntimeWrites(t, runtime, recordCommit) {
  const host = hostForControl(runtime.configService);
  const commit = host.authority.commit.bind(host.authority);
  t.mock.method(
    host.authority,
    "commit",
    async (provider, layer, key, value, remove, operationId) => {
      const outcome = await commit(provider, layer, key, value, remove, operationId);
      recordCommit(provider, outcome.result, {
        operationId: operationId ?? outcome.snapshot?.lastCommit?.operationId,
        mutation: remove
          ? { action: "remove", key }
          : { action: "set", key, value },
      });
      return outcome;
    },
  );
}

function instrumentProvider(provider, counters) {
  if (!provider.onExternalChange) return;
  const subscribe = provider.onExternalChange.bind(provider);
  provider.onExternalChange = (...arguments_) => {
    const unsubscribe = subscribe(...arguments_);
    counters.providerSubscriptions++;
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      counters.providerSubscriptionDisposals++;
    };
  };
}

function instrumentResource(resource, counters) {
  let disposed = false;
  return {
    ...resource,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await resource.dispose();
      counters.resourcesDisposed++;
    },
  };
}
