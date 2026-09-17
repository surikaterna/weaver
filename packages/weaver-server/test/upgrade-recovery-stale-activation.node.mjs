import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  canonicalInternalJson,
  validatedFinalContextsDigest,
} from "@weaver-conf/config-types";
import {
  assertStaleRow,
  forgedId,
  selected,
  zeroDigest,
} from "./upgrade-stale-matrix-fixture.mjs";

const intentRows = [
  ["activation operation/control provider+namespace", (activation) => {
    activation.operationId = randomUUID();
    activation.control.providerId = forgedId();
    activation.control.namespace = "forged";
  }],
  ["activation control store/environment/layer/epoch/sequence", (activation) => {
    Object.assign(activation.control.revision, {
      storeId: forgedId(), environment: "forged", layer: forgedId(),
      epoch: randomUUID(), sequence: "999",
    });
  }],
  ["activation mutation/candidate/prestate digests", (activation) => {
    activation.mutationDigest = zeroDigest();
    activation.candidateDigest = zeroDigest();
    activation.prestateDigest = zeroDigest();
  }],
  ["activation terminal/plan/catalog/generation", (activation) => {
    activation.terminal = "restart-required";
    activation.target.planId = zeroDigest();
    activation.target.catalogDigest = zeroDigest();
    activation.target.sourceInfrastructureGeneration = forgedId();
    activation.target.targetInfrastructureGeneration = forgedId();
  }],
  ["finalContexts run/plan/target/nonce", (activation) => {
    activation.finalContexts.runId = randomUUID();
    activation.finalContexts.planId = zeroDigest();
    activation.finalContexts.targetCatalogDigest = zeroDigest();
    activation.finalContexts.nonce = zeroDigest();
    rebindFinalContexts(activation.finalContexts);
  }],
  ["finalContexts aggregate (schema-invalid)", (activation) => {
    activation.finalContexts.aggregateDigest = zeroDigest();
  }, true],
  ["finalContexts layer provider identity", (activation) => {
    activation.finalContexts.layers[0].providerId = forgedId();
    rebindFinalContexts(activation.finalContexts);
  }],
  ["finalContexts layer namespace", (activation) => {
    activation.finalContexts.layers[0].namespace = "forged";
    rebindFinalContexts(activation.finalContexts);
  }],
  ["finalContexts layer revision", (activation) => {
    activation.finalContexts.layers[0].revision.sequence = "999";
    rebindFinalContexts(activation.finalContexts);
  }],
  ["finalContexts layer/context authority/delivered digests", (activation) => {
    activation.finalContexts.layers[0].contentDigest = zeroDigest();
    const context = activation.finalContexts.contexts[0];
    context.deliveredDigest = zeroDigest();
    rebindFinalContexts(activation.finalContexts);
  }],
];

for (const [name, mutateActivation, schemaInvalid = false] of intentRows)
  test(`stale activation: ${name}`, (t) => assertStaleRow(t, {
    name,
    phase: "activation",
    schemaInvalid,
    mutate: (envelope, runId) => mutateActivation(selected(envelope, runId).journal.activation),
  }));

const terminalRows = [
  ["activation poststate digest (schema-invalid)", (activation) => {
    activation.poststateDigest = zeroDigest();
  }, true],
  ["activation receipt operation/mutation", (activation) => {
    const operationId = randomUUID();
    activation.operationId = operationId;
    activation.receipt.operationId = operationId;
    activation.receipt.mutationDigest = zeroDigest();
  }],
  ["activation receipt prior/result revision lineage", (activation) => {
    activation.receipt.previousRevision.sequence = "999";
    activation.receipt.revision.sequence = "1000";
  }],
];

for (const [name, mutateActivation, schemaInvalid = false] of terminalRows)
  test(`stale activation: ${name}`, (t) => assertStaleRow(t, {
    name,
    phase: "terminal",
    schemaInvalid,
    mutate: (envelope, runId) => mutateActivation(selected(envelope, runId).journal.activation),
  }));

function rebindFinalContexts(binding) {
  const authorityVector = binding.layers.map((layer) => createHash("sha256")
    .update(canonicalInternalJson({
      domain: "weaver.final-context-layer.v2",
      runId: binding.runId,
      layer,
    })).digest("hex"));
  for (const context of binding.contexts)
    context.authorityVector = [...authorityVector];
  binding.aggregateDigest = validatedFinalContextsDigest(binding);
}
