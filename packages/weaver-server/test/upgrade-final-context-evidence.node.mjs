import assert from "node:assert/strict";
import { test } from "node:test";
import { validatedFinalContextsBindingSchema } from "@weaver-conf/config-types";
import {
  buildValidatedFinalContexts,
  buildValidatedFinalContextsForTest,
} from "../src/core/final-context-evidence.ts";
import { prepareActivationIntent } from "../src/core/activation-recovery.ts";

const region = [{ scopeId: "region", value: "us" }];
const tenant = [...region, { scopeId: "tenant", value: "one" }];
const nonce = "9".repeat(64);
const runId = "11111111-1111-4111-8111-111111111111";
const plan = {
  id: "a".repeat(64),
  target: { catalogDigest: "b".repeat(64) },
  contexts: [[], tenant, region],
};
const layers = [layer("app", "application", "0"), layer("control", "platform", "2")];

test("evidence preserves the exact validated projection as deeply frozen ephemeral data", () => {
  const delivered = {
    svc: {
      inherited: "base",
      recursiveReference: "resolved-reference",
      secret: "resolved-secret-sentinel",
      port: 41,
    },
  };
  let visits = 0;
  const candidate = {
    contexts: plan.contexts.map((scopePath) => ({
      scopePath,
      get entries() {
        visits++;
        return delivered;
      },
    })),
  };
  const evidence = buildValidatedFinalContextsForTest(
    plan,
    candidate,
    layers,
    runId,
    nonce,
  );
  assert.equal(visits, 3);
  assert.equal(evidence.contexts.length, 3);
  for (const context of evidence.contexts) {
    assert.deepEqual(context.prepared, delivered);
    assert.deepEqual(context.delivered, delivered);
    assert.equal(Object.isFrozen(context.delivered.svc), true);
    assert.throws(() => {
      context.delivered.svc.port = 42;
    }, TypeError);
  }
  delivered.svc.secret = "mutated-after-validation";
  assert.equal(evidence.contexts[0].delivered.svc.secret, "resolved-secret-sentinel");
  const persisted = JSON.stringify(evidence.binding);
  assert.equal(persisted.includes("resolved-secret-sentinel"), false);
  assert.equal(persisted.includes('"svc"'), false);
});

test("commitments change with run, delivered object, authority, context, nonce, and target", () => {
  const baseline = build({ value: "one", port: 41 });
  const variants = [
    build({ value: "two", port: 41 }),
    build({ value: "one", port: 41 }, { runId: "22222222-2222-4222-8222-222222222222" }),
    build({ value: "one", port: 41 }, { nonce: "8".repeat(64) }),
    build({ value: "one", port: 41 }, { planId: "c".repeat(64) }),
    build({ value: "one", port: 41 }, { catalogDigest: "d".repeat(64) }),
    build({ value: "one", port: 41 }, { scopePath: [{ scopeId: "region", value: "eu" }] }),
    build({ value: "one", port: 41 }, { sequence: "3" }),
  ];
  for (const variant of variants)
    assert.notEqual(variant.binding.aggregateDigest, baseline.binding.aggregateDigest);
});

test("production evidence uses a fresh nonce and cross-run replay stops before activation access", async () => {
  const candidate = {
    contexts: plan.contexts.map((scopePath) => ({
      scopePath,
      entries: { value: "one", port: 41 },
    })),
  };
  const first = buildValidatedFinalContexts(plan, candidate, layers, runId);
  const second = buildValidatedFinalContexts(plan, candidate, layers, runId);
  assert.notEqual(first.binding.nonce, second.binding.nonce);

  let runtimeAccesses = 0;
  const runtime = Object.defineProperty({}, "configService", {
    get() {
      runtimeAccesses++;
      throw new Error("activation authority must not be read");
    },
  });
  await assert.rejects(
    prepareActivationIntent(
      runtime,
      plan,
      { runId: "22222222-2222-4222-8222-222222222222" },
      "33333333-3333-4333-8333-333333333333",
      first.binding,
    ),
    { code: "VALIDATION_ERROR" },
  );
  assert.equal(runtimeAccesses, 0);
});

test("strict binding rejects missing, reordered, duplicate, and mutated evidence", () => {
  const binding = structuredClone(build({ value: "one", port: 41 }).binding);
  for (const mutate of [
    (value) => delete value.nonce,
    (value) => delete value.runId,
    (value) => value.runId = "22222222-2222-4222-8222-222222222222",
    (value) => value.contexts.reverse(),
    (value) => value.contexts.push(structuredClone(value.contexts[0])),
    (value) => value.contexts[0].authorityVector.reverse(),
    (value) => value.contexts[0].deliveredDigest = "0".repeat(64),
    (value) => value.aggregateDigest = "0".repeat(64),
  ]) {
    const changed = structuredClone(binding);
    mutate(changed);
    assert.equal(validatedFinalContextsBindingSchema.safeParse(changed).success, false);
  }
});

function build(entries, overrides = {}) {
  const scopePath = overrides.scopePath ?? region;
  const selectedPlan = {
    ...plan,
    id: overrides.planId ?? plan.id,
    target: { catalogDigest: overrides.catalogDigest ?? plan.target.catalogDigest },
    contexts: [[], scopePath],
  };
  const selectedLayers = layers.map((item, index) =>
    index === 0 && overrides.sequence
      ? { ...item, revision: { ...item.revision, sequence: overrides.sequence } }
      : item,
  );
  return buildValidatedFinalContextsForTest(
    selectedPlan,
    { contexts: selectedPlan.contexts.map((path) => ({ scopePath: path, entries })) },
    selectedLayers,
    overrides.runId ?? runId,
    overrides.nonce ?? nonce,
  );
}

function layer(providerId, name, sequence) {
  return {
    providerId,
    namespace: `memory:${providerId}`,
    revision: {
      storeId: `store-${providerId}`,
      environment: "test",
      layer: name,
      epoch: "11111111-1111-4111-8111-111111111111",
      sequence,
    },
    contentDigest: providerId === "app" ? "1".repeat(64) : "2".repeat(64),
  };
}
