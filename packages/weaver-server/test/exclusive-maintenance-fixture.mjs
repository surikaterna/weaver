import { createInMemoryStorageProvider } from "@weaver-conf/storage-providers";
import { createSchemaRegistry } from "../src/core/schema-registry.ts";
import { createScopeManager } from "../src/core/scope-manager.ts";
import {
  hostForControl,
  suspendControlApplication,
} from "../src/core/config-service-internal.ts";
import { createWeaverConfigService } from "../src/index.ts";
import { prepareTestService } from "./setup-service.ts";

const schemas = {
  svc: {
    type: "object",
    properties: { keep: { type: "boolean" } },
    additionalProperties: false,
  },
};

export async function createExclusiveMaintenanceFixture() {
  const counters = newCounters();
  const provider = countingProvider(counters, "app", "platform");
  const scopedProvider = countingProvider(counters, "tenant", "tenant");
  const watchedProvider = basicProvider(counters);
  const scopePath = [{ scopeId: "tenant", value: "acme" }];
  await scopedProvider.writeLayer("tenant:acme", "svc", {});
  const options = await prepareTestService(
    {
      providers: [provider, scopedProvider, watchedProvider],
      environment: "test",
      flushDebounceMs: 60_000,
    },
    schemas,
    [scopePath],
  );
  const service = await createWeaverConfigService(options);
  resetCounters(counters);
  return {
    service,
    host: hostForControl(service),
    registry: createSchemaRegistry({ configService: service }),
    scopes: createScopeManager({ configService: service }),
    counters,
    scopePath,
    close: () => service.close(),
  };
}

export function beginPending(fixture) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const blocker = fixture.host.coordinator.runApplication(async () => {
    entered.resolve();
    await release.promise;
  });
  return entered.promise.then(() => {
    const fence = suspendControlApplication(fixture.service);
    return { blocker, fence, release };
  });
}

export async function finishPending(pending) {
  pending.release.resolve();
  await Promise.all([pending.blocker, pending.fence]);
}

export async function runBeforePending(fixture, submit) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const blocker = fixture.host.coordinator.runApplication(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const operation = submit();
  const fence = suspendControlApplication(fixture.service);
  release.resolve();
  const value = await operation;
  await Promise.all([blocker, fence]);
  return value;
}

export function reopen(fixture) {
  fixture.host.maintenance.resume();
}

export function registrationRequest(serviceId = "extra") {
  return {
    serviceId,
    schema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      additionalProperties: false,
    },
    environment: "test",
    owner: { name: "fixture", contact: "fixture@example.com" },
    fragmentSlots: [],
  };
}

function newCounters() {
  return {
    load: 0,
    commit: 0,
    refresh: 0,
    flush: 0,
    watch: 0,
    watchDispose: 0,
    order: [],
    listener: undefined,
  };
}

function resetCounters(counters) {
  counters.load = 0;
  counters.commit = 0;
  counters.refresh = 0;
  counters.flush = 0;
  counters.watch = 0;
  counters.watchDispose = 0;
  counters.order.length = 0;
}

function countingProvider(counters, id, layer) {
  const base = createInMemoryStorageProvider({ id, layer });
  const authority = base.authority;
  let dirty = false;
  return {
    id: base.id,
    layer: base.layer,
    writable: base.writable,
    capabilities: base.capabilities,
    get dirty() {
      return base.dirty || dirty;
    },
    load: async () => {
      counters.load++;
      counters.order.push("load");
      return base.load();
    },
    loadLayer: (layer) => base.loadLayer(layer),
    write: (key, value) => base.write(key, value),
    writeLayer: (layer, key, value) => base.writeLayer(layer, key, value),
    remove: (key) => base.remove(key),
    removeLayer: (layer, key) => base.removeLayer(layer, key),
    refresh: async () => {
      counters.refresh++;
      counters.order.push("refresh");
    },
    flush: async () => {
      counters.flush++;
      counters.order.push("flush");
      await base.flush?.();
      dirty = false;
    },
    onExternalChange: (listener) => {
      counters.watch++;
      counters.listener = listener;
      return () => {
        counters.watchDispose++;
        counters.listener = undefined;
      };
    },
    authority: {
      capabilities: authority.capabilities,
      preflight: (layers) => authority.preflight(layers),
      acquireWriter: (owner) => authority.acquireWriter(owner),
      releaseWriter: (handle) => authority.releaseWriter(handle),
      readLayer: (layer) => authority.readLayer(layer),
      inventory: () => authority.inventory(),
      commitLayer: async (request, handle) => {
        counters.commit++;
        counters.order.push("commit");
        const result = await authority.commitLayer(request, handle);
        if (result.success) dirty = true;
        return result;
      },
    },
  };
}

function basicProvider(counters) {
  const base = createInMemoryStorageProvider({ id: "watched", layer: "local" });
  return {
    id: base.id,
    layer: base.layer,
    writable: true,
    get dirty() {
      return base.dirty;
    },
    load: () => base.load(),
    write: (key, value) => base.write(key, value),
    remove: (key) => base.remove(key),
    flush: () => base.flush(),
    onExternalChange: (listener) => {
      counters.watch++;
      counters.listener = listener;
      return () => {
        counters.watchDispose++;
        counters.listener = undefined;
      };
    },
  };
}
