import assert from "node:assert/strict";

const stderrFixtureBytes = 16 * 1024;
const testAdmin = "bootstrap-administrator-credential-000000000000000000000000";
const testJwt = "server-jwt-credential-0000000000000000000000000000000000";
let hostForControl;
let openWeaverRuntime;
let journalFrom;
let rawState;

let input = "";
const commands = [];
const waiting = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\n")) {
    const boundary = input.indexOf("\n");
    const line = input.slice(0, boundary);
    input = input.slice(boundary + 1);
    if (line) deliver(JSON.parse(line));
  }
});

function deliver(message) {
  const waiter = waiting.shift();
  if (waiter) waiter(message);
  else commands.push(message);
}

function nextCommand() {
  const command = commands.shift();
  return command ? Promise.resolve(command) : new Promise((resolve) => waiting.push(resolve));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function progress(start, type, evidence = {}) {
  send({ type, runId: start.runId, planId: start.planId, ...evidence });
}

function credentials(reference) {
  return reference === "administrator" ? testAdmin : reference === "jwt" ? testJwt : undefined;
}

function provider(runtime, id) {
  const result = hostForControl(runtime.configService).providers.find((item) => item.id === id);
  assert.ok(result?.authority);
  return result;
}

function observeCommits(runtime) {
  const counts = { control: 0, platform: 0, secondary: 0 };
  const receipts = [];
  for (const id of Object.keys(counts)) {
    const authority = provider(runtime, id).authority;
    const commit = authority.commitLayer.bind(authority);
    authority.commitLayer = async (request, handle) => {
      counts[id]++;
      const result = await commit(request, handle);
      if (result.success) receipts.push({ id, receipt: result.snapshot.lastCommit });
      return result;
    };
  }
  return { counts, receipts };
}

async function loadRuntimeModules(start, reportProgress) {
  ({ openWeaverRuntime } = await import("../src/server-runtime.ts"));
  if (reportProgress) progress(start, "runtime-module-ready");
  ({ hostForControl } = await import("../src/core/config-service-internal.ts"));
  if (reportProgress) progress(start, "authority-module-ready");
  ({ journalFrom, rawState } = await import("./upgrade-two-provider-fixture.mjs"));
  if (reportProgress) progress(start, "fixture-module-ready");
}

function observePlatformCommit(runtime, start) {
  const authority = provider(runtime, "platform").authority;
  const commit = authority.commitLayer.bind(authority);
  let reported = false;
  authority.commitLayer = async (request, handle) => {
    const result = await commit(request, handle);
    if (!reported && result.success) {
      reported = true;
      assert.equal(result.snapshot.lastCommit.operationId, request.operationId);
      progress(start, "platform-commit-durable", {
        operationId: request.operationId,
        receiptOperationId: result.snapshot.lastCommit.operationId,
      });
    }
    return result;
  };
}

async function applyUntilKilled(start) {
  const runtime = await openWeaverRuntime(start.seed, { credentials: { resolveCredential: credentials } });
  progress(start, "runtime-opened");
  const before = await rawState(runtime);
  observePlatformCommit(runtime, start);
  const secondary = provider(runtime, "secondary");
  const commit = secondary.authority.commitLayer.bind(secondary.authority);
  secondary.authority.commitLayer = async (request, handle) => {
    const current = await rawState(runtime);
    const journal = journalFrom(current, start.runId);
    if (journal?.steps[0]?.status !== "complete" ||
      journal.steps[1]?.status !== "intent" ||
      journal.steps[1].operationId !== request.operationId)
      return commit(request, handle);
    assert.equal(journal.planId, start.planId);
    assert.equal(current.platform.lastCommit.operationId, journal.steps[0].operationId);
    assert.equal(current.secondary.sequence, before.secondary.sequence);
    progress(start, "step0-complete", {
      stepId: journal.steps[0].id,
      operationId: journal.steps[0].operationId,
      receiptOperationId: journal.steps[0].receipt.operationId,
    });
    progress(start, "step1-intent", {
      stepId: journal.steps[1].id,
      operationId: journal.steps[1].operationId,
    });
    progress(start, "partial-ready", {
      platformOperationId: journal.steps[0].operationId,
      secondaryOperationId: journal.steps[1].operationId,
    });
    await nextCommand();
    assert.fail("The apply worker must be killed while blocked");
  };
  const operation = runtime.applyUpgrade({ version: 1, runId: start.runId, request: start.request });
  progress(start, "apply-invoked");
  await operation;
  assert.fail("The apply worker unexpectedly completed");
}

async function recover(start) {
  const runtime = await openWeaverRuntime(start.seed, { credentials: { resolveCredential: credentials } });
  const effects = observeCommits(runtime);
  send({ type: "locks-acquired" });
  for (;;) {
    const command = await nextCommand();
    if (command.type === "close") {
      await runtime.close();
      send({ type: "closed" });
      return;
    }
    assert.equal(command.type, "recover");
    const result = await runtime.recoverUpgrade({
      version: 1,
      runId: start.runId,
      ...(command.priorOwnerStopped ? { priorOwnerStopped: command.priorOwnerStopped } : {}),
    });
    send({ type: "recovered", result, counts: effects.counts, receipts: effects.receipts });
  }
}

async function emitBoundedStderrFixture() {
  await writeStderr("discarded-stderr-sentinel\n");
  await writeStderr(Buffer.alloc(stderrFixtureBytes * 3, "x"));
  await writeStderr("\nretained-stderr-tail-sentinel\n");
  send({ type: "stderr-ready" });
  await nextCommand();
}

function writeStderr(value) {
  return new Promise((resolve, reject) => {
    process.stderr.write(value, (error) => error ? reject(error) : resolve());
  });
}

async function main() {
  const start = await nextCommand();
  assert.equal(start.type, "start");
  if (start.mode === "stderr-stall") {
    send({ type: "worker-online" });
    await emitBoundedStderrFixture();
    return;
  }
  if (start.mode === "apply") {
    progress(start, "worker-online");
    await loadRuntimeModules(start, true);
    await applyUntilKilled(start);
    return;
  }
  await loadRuntimeModules(start, false);
  await recover(start);
}

main().then(
  () => process.stdin.destroy(),
  (error) => {
    send({ type: "error", code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR" });
    process.exitCode = 1;
    process.stdin.destroy();
  },
);
