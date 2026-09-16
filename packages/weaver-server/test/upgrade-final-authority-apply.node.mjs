import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { hostForControl } from "../src/core/config-service-internal.ts";
import {
  assertSanitizedSurfaces,
  authoritySnapshot,
  captureExpectedFailure,
  durableFileSnapshot,
  durableReplace,
  interceptFinalBoundary,
  observeNoAdmission,
  onlyJournal,
  withFinalMatrixRuntime,
} from "./upgrade-final-matrix-fixture.mjs";
import {
  assertExactDurableDeltas,
  assertExactFailureCommits,
  assertNoRecoveryCommits,
} from "./upgrade-final-effect-proof.mjs";

const authorityRows = [
  ["unrecorded later revision", "VALIDATION_ERROR", "Upgrade validation failed", async (path) => {
    const envelope = await readEnvelope(path);
    const previousRevision = revision(envelope);
    const next = { ...previousRevision, sequence: `${BigInt(envelope.sequence) + 1n}` };
    await durableReplace(path, {
      ...envelope,
      ...next,
      lastCommit: {
        operationId: randomUUID(),
        previousRevision,
        revision: next,
        mutationDigest: "2".repeat(64),
      },
    });
  }],
  ["same-revision content divergence", "VALIDATION_ERROR", "Upgrade validation failed", async (path) => {
    const envelope = await readEnvelope(path);
    envelope.entries.svc.marker = "divergent-private-value";
    await durableReplace(path, envelope);
  }],
  ["missing authoritative layer read", "INTERNAL_ERROR", "Upgrade storage operation failed", async (path) => {
    await unlink(path);
    await syncDirectory(dirname(path));
  }],
  ["malformed authority envelope", "INTERNAL_ERROR", "Upgrade storage operation failed",
    (path) => durableReplace(path, { malformed: true })],
  ["extra inventory layer", "UNSUPPORTED_AUTHORITY", "Upgrade ownership could not be established", async (path) => {
    await durableReplace(join(dirname(path), "unbound-layer.json"), { durable: true });
  }],
];

for (const [name, code, message, corrupt] of authorityRows)
  test(`real apply rejects ${name}`, async (t) => {
    await withFinalMatrixRuntime(t, async (context) => {
      const { fixture, runtime, request, providerEffects, effectCheckpoint } = context;
      const path = join(fixture.directory, "platform", "entries.json");
      const initial = await authoritySnapshot(runtime);
      const rawInitial = await durableFileSnapshot(fixture);
      let prepared;
      interceptFinalBoundary(t, runtime, async () => {
        prepared = await authoritySnapshot(runtime);
        await corrupt(path);
      });
      const effects = observeNoAdmission(t, runtime);
      const failure = await captureExpectedFailure(
        runtime.applyUpgrade({ version: 1, request }),
        code,
        message,
      );
      const after = await rawAuthorityProof(path, name);
      assert.notDeepEqual(await durableFileSnapshot(fixture), rawInitial);
      const journal = onlyJournal(await controlAuthoritySnapshot(runtime));
      assert.equal(journal.phase, "verifying");
      const preparedJournal = onlyJournal(prepared.control);
      assertExactDurableDeltas(initial, prepared, preparedJournal);
      const intentCount = journal.activation.status === "intent" ? 1 : 0;
      assertExactFailureCommits(
        providerEffects.delta(effectCheckpoint), journal, intentCount,
      );
      assert.notEqual(runtime.state, "ready");
      effects.assertNone();
      await assertSanitizedSurfaces(runtime, failure, ["divergent-private-value"]);
      effects.close();
      await assertRecoveryIsEffectFree(t, name, journal, context);
      assert.equal(await rawAuthorityProof(path, name), after);
    });
  });

async function rawAuthorityProof(path, name) {
  if (name === "missing authoritative layer read")
    return assert.rejects(readFile(path, "utf8")).then(() => "missing");
  if (name === "extra inventory layer")
    return readFile(join(dirname(path), "unbound-layer.json"), "utf8");
  return readFile(path, "utf8");
}

async function controlAuthoritySnapshot(runtime) {
  const host = hostForControl(runtime.configService);
  const control = host.pipeline.controlProvider;
  return control.authority.readLayer(control.layer);
}

async function readEnvelope(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function revision(envelope) {
  const { storeId, environment, layer, epoch, sequence } = envelope;
  return { storeId, environment, layer, epoch, sequence };
}

async function assertRecoveryIsEffectFree(t, name, journal, context) {
  const { fixture, reopen, providerEffects } = context;
  const raw = await durableFileSnapshot(fixture);
  const checkpoint = providerEffects.checkpoint();
  const startupFailure = startupFailures[name];
  if (startupFailure) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await captureExpectedFailure(reopen, ...startupFailure);
      assert.deepEqual(await durableFileSnapshot(fixture), raw);
    }
  } else {
    assert.ok(["pending", "intent"].includes(journal.activation.status));
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = await reopen();
      const effects = observeNoAdmission(t, fresh);
      try {
        const failure = await captureExpectedFailure(
          fresh.recoverUpgrade({ version: 1, runId: journal.runId }),
          "FORBIDDEN",
          "Upgrade ownership could not be established",
        );
        effects.assertNone();
        await assertSanitizedSurfaces(fresh, failure, ["divergent-private-value"]);
        assert.notEqual(fresh.state, "ready");
      } finally {
        effects.close();
        await fresh.close();
      }
      assert.deepEqual(await durableFileSnapshot(fixture), raw);
    }
  }
  assertNoRecoveryCommits(providerEffects.delta(checkpoint));
  providerEffects.assertNoSubscriptions();
  providerEffects.assertDisposed();
}

const startupFailures = {
  "missing authoritative layer read": [
    "PROVIDER_CORRUPT",
    "WeaverError: Missing or unreadable initialized layer envelope",
  ],
  "malformed authority envelope": [
    "PROVIDER_CORRUPT",
    "WeaverError: Invalid or unsupported layer envelope",
  ],
  "extra inventory layer": [
    "UNSUPPORTED_AUTHORITY",
    "WeaverError: Unmanaged namespace entry: unbound-layer.json",
  ],
};
