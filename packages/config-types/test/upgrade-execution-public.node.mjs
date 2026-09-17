import assert from "node:assert/strict";
import { test } from "node:test";
import {
  maintenanceStatusSchema,
  publicMaintenanceFailure,
  upgradeExecutionResultSchema,
} from "../src/index.ts";

const secrets = [
  "/home/user/secret",
  "mongodb://user:pass@host/database",
  "token=operator-token",
  'SecretReference({"ref":"credential"})',
  "\u001b[31mstack\nline",
  "x".repeat(10_000),
];

test("public maintenance contracts accept only bounded stable failures", () => {
  for (const code of [
    "stale-plan",
    "conflict",
    "unknown-commit",
    "validation",
    "ownership",
    "storage",
    "operator-required",
    "internal",
  ]) {
    const failure = publicMaintenanceFailure(code);
    assert.equal(JSON.stringify(failure).includes("undefined"), false);
  }
  const result = upgradeExecutionResultSchema.parse({
    version: 1,
    status: "blocked",
    effects: {
      partialEffects: true,
      completedSteps: 1,
      pendingSteps: 2,
      quarantinedProviders: ["provider_1"],
    },
    failure: publicMaintenanceFailure("storage"),
  });
  maintenanceStatusSchema.parse({
    version: 1,
    state: "failed",
    ready: false,
    failure: publicMaintenanceFailure("storage"),
  });
  const serialized = JSON.stringify(result);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
});

test("public maintenance contracts reject reflected and untrusted output", () => {
  assert.throws(() =>
    upgradeExecutionResultSchema.parse({
      version: 1,
      status: "blocked",
      effects: {
        partialEffects: false,
        completedSteps: 0,
        pendingSteps: 0,
        quarantinedProviders: ["mongodb://user:pass@host/database"],
      },
      failure: {
        code: "storage",
        category: "storage",
        message: secrets.join("\n"),
      },
    }),
  );
});
