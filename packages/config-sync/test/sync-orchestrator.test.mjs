
import { createConfigSyncOrchestrator, MemoryDurableConfigCacheAdapter } from "../dist/index.js";

function createTransportHarness() {
  const pushQueue = [];
  const pullQueue = [];
  const pushes = [];
  const pulls = [];
  const acks = [];

  const transport = {
    async pull(request) {
      pulls.push(request);
      return pullQueue.shift() ?? {
        cursor: { serverRevision: "rev-0", serverTime: 0 },
        serverTime: 0,
        changes: [],
      };
    },
    async push(request) {
      pushes.push(request);
      const next = pushQueue.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next ?? {
        requestId: request.requestId,
        serverRevision: "rev-1",
        serverTime: Date.now(),
        results: request.mutations.map((mutation, idx) => ({
          mutationId: mutation.mutationId,
          accepted: true,
          revision: `rev-${idx + 1}`,
        })),
      };
    },
    async ack(request) {
      acks.push(request);
      return {
        requestId: request.requestId,
        acked: true,
        serverRevision: "rev-ack",
        serverTime: Date.now(),
      };
    },
  };

  return { transport, pushQueue, pullQueue, pushes, pulls, acks };
}

test("offline boot reads cache snapshot without network", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  await cache.saveSnapshot({
    entries: { "example.theme": "dark" },
    revision: "rev-cached",
    lastSyncedAt: 100,
  });
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  const snapshot = await orchestrator.load();

  expect(snapshot.entries["example.theme"]).toBe("dark");
  expect(harness.pushes.length).toBe(0);
  expect(harness.pulls.length).toBe(0);
  expect(orchestrator.getSyncState().status).toBe("offline");
});

test("reconnect flushes queued writes then pulls", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.theme", "dark");
  expect((await cache.getQueueMetadata()).pendingCount).toBe(1);

  harness.pullQueue.push({
    cursor: { serverRevision: "rev-2", serverTime: 300 },
    serverTime: 300,
    changes: [],
  });

  orchestrator.setOnline(true);
  const result = await orchestrator.sync();

  expect(result.pushed).toBe(1);
  expect(result.pulled).toBe(0);
  expect(harness.pushes.length).toBe(1);
  expect(harness.acks.length).toBe(1);
  expect((await cache.getQueueMetadata()).pendingCount).toBe(0);
  expect(orchestrator.getSyncState().status).toBe("synced");
});

test("conflict path surfaces conflict state and server value", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.mode", "compact");
  const queued = await cache.peekQueuedMutations(10);

  harness.pushQueue.push({
    requestId: "req-1",
    serverRevision: "rev-22",
    serverTime: 500,
    results: [
      {
        mutationId: queued[0].mutationId,
        accepted: false,
        conflict: {
          key: "example.mode",
          mutationId: queued[0].mutationId,
          localRevision: "rev-10",
          serverRevision: "rev-22",
          localValue: "compact",
          serverValue: "expanded",
          serverTime: 500,
        },
      },
    ],
  });
  harness.pullQueue.push({
    cursor: { serverRevision: "rev-22", serverTime: 500 },
    serverTime: 500,
    changes: [],
  });

  orchestrator.setOnline(true);
  const result = await orchestrator.sync();
  expect(result.conflicts.length).toBe(1);
  expect(result.conflicts[0].key).toBe("example.mode");
  expect(orchestrator.getSyncState().status).toBe("conflict");
});

test("lww-fallback requeues mutation after conflict", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
    conflictResolution: "lww-fallback",
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.mode", "compact");
  const queued = await cache.peekQueuedMutations(10);

  harness.pushQueue.push({
    requestId: "req-1",
    serverRevision: "rev-22",
    serverTime: 500,
    results: [
      {
        mutationId: queued[0].mutationId,
        accepted: false,
        conflict: {
          key: "example.mode",
          mutationId: queued[0].mutationId,
          localRevision: "rev-10",
          serverRevision: "rev-22",
          localValue: "compact",
          serverValue: "expanded",
          serverTime: 500,
        },
      },
    ],
  });
  const lwwError = new Error("offline");
  lwwError.code = "network";
  lwwError.retryable = true;
  harness.pushQueue.push(lwwError);
  harness.pullQueue.push({
    cursor: { serverRevision: "rev-22", serverTime: 500 },
    serverTime: 500,
    changes: [],
  });

  orchestrator.setOnline(true);
  await orchestrator.sync();
  const after = await cache.peekQueuedMutations(10);
  expect(after.length).toBe(1);
  expect(after[0].baseRevision).toBe("rev-22");
});

test("retryable error keeps queue and schedules retry", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const nowValues = [1000, 1010, 1020, 1030, 1040, 1050];
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
    now: () => nowValues.shift() ?? 2000,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.retry", true);
  const retryError = new Error("offline");
  retryError.code = "network";
  retryError.retryable = true;
  harness.pushQueue.push(retryError);

  orchestrator.setOnline(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queue = await cache.getQueueMetadata();
  const diagnostics = orchestrator.getDiagnostics();

  expect(queue.pendingCount).toBe(1);
  expect(orchestrator.getSyncState().status).toBe("error");
  expect(diagnostics.pendingCount).toBe(1);
  expect("retryAttempt" in diagnostics).toBe(false);
  expect("retryScheduledAt" in diagnostics).toBe(false);
  expect("queue" in diagnostics).toBe(false);
  expect(diagnostics.lastError).toEqual({
    code: "network",
    message: "offline",
    retryable: true,
  });
});

test("tenant isolation via separate orchestrator instances with separate caches", async () => {
  const cacheA = new MemoryDurableConfigCacheAdapter();
  const cacheB = new MemoryDurableConfigCacheAdapter();
  const harnessA = createTransportHarness();
  const harnessB = createTransportHarness();

  const a = createConfigSyncOrchestrator({
    snapshotCache: cacheA,
    mutationQueue: cacheA,
    transport: harnessA.transport,
  });
  const b = createConfigSyncOrchestrator({
    snapshotCache: cacheB,
    mutationQueue: cacheB,
    transport: harnessB.transport,
  });

  a.setOnline(false);
  b.setOnline(false);
  await a.load();
  await b.load();
  await a.write("example.theme", "dark");
  await b.write("example.theme", "light");

  const queueA = await cacheA.peekQueuedMutations(10);
  const queueB = await cacheB.peekQueuedMutations(10);

  expect(queueA.length).toBe(1);
  expect(queueB.length).toBe(1);
  expect(queueA[0].mutationId).not.toBe(queueB[0].mutationId);
});

// --- Error classification (tested indirectly via orchestrator behavior) ---

test("error classification: SyncErrorMetadata object passes through unchanged", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.key", "val");

  const err = new Error("server error");
  err.code = "server";
  err.retryable = true;
  harness.pushQueue.push(err);

  orchestrator.setOnline(true);
  await new Promise((r) => setTimeout(r, 0));
  const diag = orchestrator.getDiagnostics();
  expect(diag.lastError).toEqual({ code: "server", message: "server error", retryable: true });
});

test("error classification: plain Error gets code unknown and retryable false", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.key", "val");

  harness.pushQueue.push(new Error("something broke"));

  orchestrator.setOnline(true);
  await new Promise((r) => setTimeout(r, 0));
  const diag = orchestrator.getDiagnostics();
  expect(diag.lastError).toEqual({ code: "unknown", message: "something broke", retryable: false });
});

test("error classification: error with syncError property is unwrapped", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.key", "val");

  const wrapper = new Error("wrapper");
  wrapper.syncError = { code: "timeout", message: "timed out", retryable: true };
  harness.pushQueue.push(wrapper);

  orchestrator.setOnline(true);
  await new Promise((r) => setTimeout(r, 0));
  const diag = orchestrator.getDiagnostics();
  expect(diag.lastError).toEqual({ code: "timeout", message: "timed out", retryable: true });
});

// --- Batch push behavior ---

test("batch push sends multiple batches when queue exceeds batchSize", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
    batchSize: 2,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("k1", "v1");
  await orchestrator.write("k2", "v2");
  await orchestrator.write("k3", "v3");
  await orchestrator.write("k4", "v4");

  harness.pullQueue.push({
    cursor: { serverRevision: "rev-10", serverTime: 1000 },
    serverTime: 1000,
    changes: [],
  });

  orchestrator.setOnline(true);
  const result = await orchestrator.sync();

  expect(result.pushed).toBe(4);
  expect(harness.pushes.length >= 2).toBeTruthy();
});

// --- Remove operation ---

test("remove() creates a remove mutation and deletes key from snapshot", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.theme", "dark");
  await orchestrator.remove("example.theme");

  const queued = await cache.peekQueuedMutations(10);
  const removeMutation = queued.find((m) => m.operation === "remove");
  expect(removeMutation).toBeTruthy();
  expect(removeMutation.key).toBe("example.theme");

  const snapshot = await cache.loadSnapshot();
  expect(snapshot.entries["example.theme"]).toBe(undefined);
});

// --- Online/offline transitions ---

test("offline to online triggers sync", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.key", "val");

  harness.pullQueue.push({
    cursor: { serverRevision: "rev-5", serverTime: 500 },
    serverTime: 500,
    changes: [],
  });

  orchestrator.setOnline(true);
  const result = await orchestrator.sync();
  expect(result.pushed).toBe(1);
  expect(orchestrator.getSyncState().status).toBe("synced");
});

test("going offline sets status to offline and clears retry", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  expect(orchestrator.getSyncState().status).toBe("offline");

  // Going offline again is idempotent
  orchestrator.setOnline(false);
  expect(orchestrator.getSyncState().status).toBe("offline");
});

test("double setOnline(false) is idempotent", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  orchestrator.setOnline(false);
  orchestrator.setOnline(false);
  expect(orchestrator.getSyncState().status).toBe("offline");
  expect(harness.pushes.length).toBe(0);
  expect(harness.pulls.length).toBe(0);
});

// --- Diagnostics and state listeners ---

test("onSyncStateChange listener fires on state transitions", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  const states = [];
  orchestrator.onSyncStateChange((state) => states.push(state.status));

  orchestrator.setOnline(false);
  await orchestrator.load();

  expect(states.includes("offline")).toBeTruthy();
});

test("onDiagnosticsChange listener fires on diagnostics updates", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  const diagnosticsLog = [];
  orchestrator.onDiagnosticsChange((d) => diagnosticsLog.push({ ...d }));

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.key", "val");

  expect(diagnosticsLog.length > 0).toBeTruthy();
});

test("unsubscribe from listeners stops notifications", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  const states = [];
  const unsub = orchestrator.onSyncStateChange((state) => states.push(state.status));

  orchestrator.setOnline(false);
  await orchestrator.load();
  const countAfterOffline = states.length;

  unsub();
  orchestrator.setOnline(true);
  // After unsub, no new states should be added
  // Allow any triggered sync to settle
  await new Promise((r) => setTimeout(r, 50));
  expect(states.length).toBe(countAfterOffline);
});

// --- Pull with server changes ---

test("pullChanges applies server-side changes to snapshot", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();

  harness.pullQueue.push({
    cursor: { serverRevision: "rev-5", serverTime: 500 },
    serverTime: 500,
    changes: [
      { key: "server.key", value: "server-value", operation: "set", revision: "rev-5" },
    ],
  });

  orchestrator.setOnline(true);
  const result = await orchestrator.sync();
  expect(result.pulled).toBe(1);

  const snapshot = await cache.loadSnapshot();
  expect(snapshot.entries["server.key"]).toBe("server-value");
});

// --- getPendingWrites ---

test("getPendingWrites contains written key before sync", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.pending", "value");

  const pending = orchestrator.getPendingWrites();
  expect(pending.has("example.pending")).toBe(true);
  expect(pending.get("example.pending")).toBe("value");
});

test("getPendingWrites is cleared after successful sync", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  await orchestrator.write("example.pending", "value");

  harness.pullQueue.push({
    cursor: { serverRevision: "rev-5", serverTime: 500 },
    serverTime: 500,
    changes: [],
  });

  orchestrator.setOnline(true);
  await orchestrator.sync();

  const pending = orchestrator.getPendingWrites();
  expect(pending.has("example.pending")).toBe(false);
  expect(pending.size).toBe(0);
});

// --- Pull error handling ---

test("pullChanges error sets error state and schedules retry for retryable errors", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();

  // Make pull throw a retryable network error
  const pullError = new Error("connection refused");
  pullError.syncError = { code: "network", message: "connection refused", retryable: true };
  harness.pullQueue.length = 0;
  const originalPull = harness.transport.pull;
  harness.transport.pull = async () => { throw pullError; };

  orchestrator.setOnline(true);
  const result = await orchestrator.sync();

  expect(result.pulled).toBe(0);
  expect(orchestrator.getSyncState().status).toBe("error");
  const diag = orchestrator.getDiagnostics();
  expect(diag.lastError).toEqual({ code: "network", message: "connection refused", retryable: true });

  // Restore pull for cleanup
  harness.transport.pull = originalPull;
});

test("pullChanges non-retryable error sets error state without scheduling retry", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
  });

  orchestrator.setOnline(false);
  await orchestrator.load();

  harness.transport.pull = async () => { throw new Error("fatal parse error"); };

  orchestrator.setOnline(true);
  const result = await orchestrator.sync();

  expect(result.pulled).toBe(0);
  expect(orchestrator.getSyncState().status).toBe("error");
  const diag = orchestrator.getDiagnostics();
  expect(diag.lastError).toEqual({ code: "unknown", message: "fatal parse error", retryable: false });
});

test("onSnapshotChange fires after successful pull with changes", async () => {
  const cache = new MemoryDurableConfigCacheAdapter();
  const harness = createTransportHarness();
  const snapshots = [];

  harness.pullQueue.push({
    cursor: { serverRevision: "rev-2", serverTime: 200 },
    serverTime: 200,
    changes: [
      { key: "theme", value: "dark", operation: "set", revision: "rev-2" },
    ],
  });

  const orchestrator = createConfigSyncOrchestrator({
    snapshotCache: cache,
    mutationQueue: cache,
    transport: harness.transport,
    onSnapshotChange: (snapshot) => { snapshots.push(snapshot); },
  });

  orchestrator.setOnline(false);
  await orchestrator.load();
  orchestrator.setOnline(true);
  await orchestrator.sync();

  expect(snapshots.length).toBe(1);
  expect(snapshots[0].entries["theme"]).toBe("dark");
  expect(snapshots[0].revision).toBe("rev-2");
});
