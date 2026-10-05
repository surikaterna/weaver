export const browserExports = [
  "DEFAULT_PLUGIN_MANAGEMENT_RATCHET_RULES",
  "createInMemoryOverrideTracker",
  "evaluateChangePolicy",
  "validateChangePolicies",
  "validateOneWayRatchet",
];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export function record(id = "override-1") {
  return {
    id, key: "service.token", actor: "ops", reason: "incident", layer: "scope",
    scopePath: [{ scopeId: "tenant", value: "tenant-1" }],
    createdAt: "2026-09-30T00:00:00.000Z",
  };
}

function checkPolicy(api) {
  const context = { userId: "ops", roles: ["admin"] };
  const schema = { type: "string" };
  const authorize = (ctx, layer, key, supplied) => {
    check(ctx === context && layer === "app" && key === "" && supplied === schema,
      "authorization must receive original arguments");
    return false;
  };
  check(api.evaluateChangePolicy(schema, context, "app", authorize).outcome === "denied", "base denial");
  check(api.evaluateChangePolicy(schema, context, "app", () => true).outcome === "allowed", "default allow");
  for (const policy of ["staging-gate", "full-pipeline"]) {
    const gated = { "x-weaver": { changePolicy: policy } };
    check(api.evaluateChangePolicy(gated, context, "app", () => true).outcome === "requires-promotion", policy);
  }
  const emergency = { "x-weaver": { changePolicy: "emergency-override" } };
  for (const ctx of [context, { ...context, sessionMode: "emergency-override", overrideReason: "" }]) {
    check(api.evaluateChangePolicy(emergency, ctx, "app", () => true).outcome === "requires-emergency-auth", "emergency auth required");
  }
  const authorized = { ...context, sessionMode: "emergency-override", overrideReason: "incident" };
  check(api.evaluateChangePolicy(emergency, authorized, "app", () => true).outcome === "allowed", "emergency authorized");
  check(api.evaluateChangePolicy(emergency, authorized, "app", () => false).outcome === "denied", "emergency cannot bypass base permission");
}

function checkValidators(api) {
  const findings = api.validateChangePolicies(new Map([
    ["service.token", { schema: { type: "string" } }],
  ]));
  check(findings.length === 1 && findings[0].severity === "error" && findings[0].suggestedPolicy === "full-pipeline", "sensitive key validation");
  const result = api.validateOneWayRatchet([
    { layer: "core", values: { changePolicy: "direct-allowed" } },
    { layer: "app", values: { changePolicy: "full-pipeline" } },
    { layer: "user", values: { changePolicy: "staging-gate" } },
  ], api.DEFAULT_PLUGIN_MANAGEMENT_RATCHET_RULES, { layerOrder: ["core", "app", "user"] });
  check(result.evaluations[0].transition === "tightened", "tightening");
  check(result.violations.length === 1 && result.violations[0].transition === "loosened", "loosening");
}

export async function exerciseBrowser(api) {
  check(Object.keys(api).sort().join() === browserExports.join(), "exact browser exports");
  checkPolicy(api);
  checkValidators(api);
  const tracker = api.createInMemoryOverrideTracker({ followUpDeadlineMs: 1000 });
  const created = await tracker.create(record());
  check(created.followUpDeadline === "2026-09-30T00:00:01.000Z", "configured deadline");
  check(JSON.stringify(created.scopePath) === JSON.stringify(record().scopePath) && created.actor === "ops" && created.layer === "scope", "canonical record");
  check((await tracker.listActive()).length === 1, "active record");
  check((await tracker.listOverdue(created.followUpDeadline)).length === 0, "deadline boundary");
  check((await tracker.listOverdue("2026-09-30T00:00:02.000Z")).length === 1, "overdue record");
  check(await tracker.regularize("missing", "reviewer") === undefined, "unknown record");
  const regularized = await tracker.regularize(created.id, "reviewer");
  check(regularized.regularizedBy === "reviewer" && Number.isFinite(Date.parse(regularized.regularizedAt)), "regularization");
  check((await tracker.listActive()).length === 0 && (await tracker.listOverdue("2027-01-01")).length === 0, "regularized excluded");
}
