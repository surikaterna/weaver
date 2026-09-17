import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frozen = (files) => Object.freeze([...files].sort());

export const defaultNodePartitions = Object.freeze({
  "activation-recovery": frozen(["test/upgrade-activation-recovery.node.mjs"]),
  "compensation": frozen(["test/upgrade-compensation.node.mjs"]),
  "core-catalog": frozen([
    "test/authority-audit.node.mjs",
    "test/builtin-catalog-audit.node.mjs",
    "test/builtin-catalog.node.mjs",
    "test/builtin-recovery-audit.node.mjs",
    "test/builtin-recovery-order.node.mjs",
    "test/builtin-recovery.node.mjs",
    "test/core-foundation.node.mjs",
    "test/foundation-integration.node.mjs",
    "test/pinned-recovery-startup.node.mjs",
    "test/retired-inspection.node.mjs",
  ]),
  "core-lifecycle": frozen([
    "test/application-maintenance-barrier.node.mjs",
    "test/application-maintenance-runtime.node.mjs",
    "test/control-operation-lifetime.node.mjs",
    "test/maintenance-barrier-core.node.mjs",
    "test/maintenance-barrier-transports.node.mjs",
    "test/maintenance-batch-context.node.mjs",
    "test/scope-lifecycle-rest.node.mjs",
  ]),
  "core-pipeline": frozen([
    "test/pipeline-acceptance.node.mjs",
    "test/pipeline-input-ownership.node.mjs",
    "test/repair-transition.node.mjs",
    "test/rollback-current.node.mjs",
    "test/validated-pipeline.node.mjs",
  ]),
  "final-b": frozen([
    "test/upgrade-final-context-evidence.node.mjs",
    "test/upgrade-final-context-request-apply.node.mjs",
    "test/upgrade-final-contexts.node.mjs",
    "test/upgrade-final-resolution-matrix.node.mjs",
  ]),
  "node-bootstrap": frozen([
    "test/bootstrap-private-file.node.mjs",
    "test/bootstrap-providers.node.mjs",
    "test/bootstrap-remediation.node.mjs",
    "test/bootstrap-runtime.node.mjs",
  ]),
  "node-cli": frozen(["test/bootstrap-cli.node.mjs"]),
  "node-schema": frozen([
    "test/schema-foundations/audit-default-context.node.mjs",
    "test/schema-foundations/audit-dynamic-defaults.node.mjs",
    "test/schema-foundations/audit-marker-defaults.node.mjs",
    "test/schema-foundations/audit-regex.node.mjs",
    "test/schema-foundations/audit-synthesized-markers.node.mjs",
    "test/schema-foundations/bootstrap-admission.node.mjs",
    "test/schema-foundations/defaults.node.mjs",
    "test/schema-foundations/grammar.node.mjs",
    "test/schema-foundations/slots.node.mjs",
  ]),
  "node-u9-fs": frozen(["test/upgrade-two-provider-recovery.node.mjs"]),
  "node-u9-process": frozen(["test/upgrade-two-provider-subprocess.node.mjs"]),
  "node-upgrade-crash": frozen(["test/upgrade-recovery-crash-matrix.node.mjs"]),
  "node-upgrade-terminal": frozen(["test/upgrade-terminal-recovery.node.mjs"]),
  "stale-activation": frozen(["test/upgrade-recovery-stale-activation.node.mjs"]),
  "stale-journal": frozen(["test/upgrade-recovery-stale-journal.node.mjs"]),
  "stale-plan": frozen(["test/upgrade-recovery-stale-plan.node.mjs"]),
  "upgrade-final-a": frozen([
    "test/upgrade-final-authority-apply.node.mjs",
    "test/upgrade-final-authority-lineage.node.mjs",
    "test/upgrade-final-binding-apply.node.mjs",
    "test/upgrade-final-receipt-apply.node.mjs",
  ]),
  "upgrade-main": frozen([
    "test/upgrade-definition-admission.node.mjs",
    "test/upgrade-maintenance.node.mjs",
    "test/upgrade-planner.node.mjs",
  ]),
  "upgrade-policy": frozen([
    "test/upgrade-application-toctou.node.mjs",
    "test/upgrade-public-secrecy.node.mjs",
    "test/upgrade-write-result.node.mjs",
  ]),
});

export const defaultVitestPartitions = Object.freeze({
  "vitest-core": frozen([
    "test/audit/audit-service.test.mjs",
    "test/audit/sinks.test.mjs",
    "test/auth/auth-middleware.test.mjs",
    "test/auth/jwt-validator.test.mjs",
    "test/config-service.test.ts",
    "test/core/change-detector.test.mjs",
    "test/core/config-service.test.mjs",
    "test/core/promotion-engine.test.mjs",
    "test/core/resolution-pipeline.test.mjs",
    "test/core/schema-registry.test.mjs",
    "test/core/schema-write-pipeline.test.mjs",
    "test/core/scope-manager.test.mjs",
    "test/core/session-manager.test.mjs",
    "test/core/webhook-handler.test.mjs",
    "test/core/write-path.test.mjs",
    "test/health.test.mjs",
    "test/partition-manifest.test.mjs",
    "test/schema-registry.test.ts",
    "test/shutdown.test.mjs",
    "test/types/delta.test.mjs",
    "test/types/errors.test.mjs",
    "test/types/snapshot.test.mjs",
  ]),
  "vitest-transport": frozen([
    "src/http-server-errors.test.ts",
    "src/server-sse-cancellation-http.test.ts",
    "src/server-sse-scope-http.test.ts",
    "src/transport/rest-adapter.test.ts",
    "src/transport/rest-schema-admin-auth.test.ts",
    "src/transport/rest-schema-routes-audit.test.ts",
    "src/transport/rest-schema-routes-auth.test.ts",
    "src/transport/rest-schema-routes-missing-auth.test.ts",
    "src/transport/rest-security-regressions.test.ts",
    "src/transport/scope-boundary-regressions.test.ts",
    "src/transport/sse-adapter.test.ts",
    "src/transport/sse-creation-cancellation.test.ts",
    "test/transport/auth-gate.test.mjs",
    "test/transport/glob-matcher.test.mjs",
    "test/transport/rest-adapter.test.mjs",
    "test/transport/scomp-service.test.mjs",
    "test/transport/sse-adapter.test.mjs",
  ]),
});

export const defaultPartitionManifest = Object.freeze({
  ...defaultNodePartitions,
  ...defaultVitestPartitions,
});

export const liveNodePartitions = Object.freeze({
  "live-mongo-conflicts": frozen(["test/upgrade-mongo-conflicts.node.mjs"]),
  "live-mongo-integration": frozen(["test/upgrade-mongo-live-integration.node.mjs"]),
  "live-mongo-terminal": frozen(["test/upgrade-mongo-terminal.node.mjs"]),
});

export const liveVitestPartitions = Object.freeze({});

export const livePartitionManifest = Object.freeze({
  ...liveNodePartitions,
  ...liveVitestPartitions,
});

export const gateManifests = Object.freeze({
  default: defaultPartitionManifest,
  live: livePartitionManifest,
});

export const expectedGateCounts = Object.freeze({
  default: Object.freeze({ node: 59, vitest: 39 }),
  live: Object.freeze({ node: 3, vitest: 0 }),
});

export const partitionManifest = Object.freeze({
  ...defaultPartitionManifest,
  ...livePartitionManifest,
});

const suiteEntries = (partitions, suite) =>
  Object.keys(partitions).map((name) => [name, suite]);

export const partitionSuites = Object.freeze(Object.fromEntries([
  ...suiteEntries(defaultNodePartitions, "node"),
  ...suiteEntries(defaultVitestPartitions, "vitest"),
  ...suiteEntries(liveNodePartitions, "node"),
  ...suiteEntries(liveVitestPartitions, "vitest"),
]));

export const partitionGates = Object.freeze(Object.fromEntries([
  ...Object.keys(defaultPartitionManifest).map((name) => [name, "default"]),
  ...Object.keys(livePartitionManifest).map((name) => [name, "live"]),
]));

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posixRelative = (file) => path.relative(packageRoot, file).split(path.sep).join("/");

async function regularFiles(directory, recursive) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isFile()) files.push(absolute);
    if (recursive && entry.isDirectory()) files.push(...await regularFiles(absolute, true));
  }
  return files;
}

export async function discoverTestInventory() {
  const testRoot = path.join(packageRoot, "test");
  const schemaRoot = path.join(testRoot, "schema-foundations");
  const srcRoot = path.join(packageRoot, "src");
  const rootNode = (await regularFiles(testRoot, false)).filter((file) => file.endsWith(".node.mjs"));
  const schemaNode = (await regularFiles(schemaRoot, false)).filter((file) => file.endsWith(".node.mjs"));
  const vitest = [...await regularFiles(testRoot, true), ...await regularFiles(srcRoot, true)]
    .filter((file) => file.endsWith(".test.ts") || file.endsWith(".test.mjs"));
  return Object.freeze({
    node: frozen([...rootNode, ...schemaNode].map(posixRelative)),
    vitest: frozen(vitest.map(posixRelative)),
  });
}

function issueSummary(issues) {
  const limit = 20;
  const shown = issues.slice(0, limit).map((issue) => `- ${issue}`);
  if (issues.length > limit) shown.push(`- ... ${issues.length - limit} more`);
  return `Partition manifest invalid (${issues.length} issues):\n${shown.join("\n")}`;
}

function collectAssignments(inventory, manifests, expected, issues) {
  const assigned = new Map();
  const gateCounts = {};
  for (const gate of Object.keys(manifests).sort()) {
    const manifest = manifests[gate];
    gateCounts[gate] = { node: 0, vitest: 0 };
    for (const name of Object.keys(manifest).sort()) {
      const files = manifest[name];
      const suite = partitionSuites[name];
      if (!suite) issues.push(`unknown partition: ${gate}: ${name}`);
      if (partitionGates[name] !== gate) issues.push(`wrong gate: ${gate}: ${name}`);
      if (files.length === 0) issues.push(`empty partition: ${gate}: ${name}`);
      if (suite) gateCounts[gate][suite] += files.length;
      for (const file of files) {
        const owners = assigned.get(file) ?? [];
        owners.push(`${gate}/${name}`);
        assigned.set(file, owners);
        if (!expected.has(file)) issues.push(`stale assignment: ${gate}/${name}: ${file}`);
        else if (!inventory[suite]?.includes(file)) issues.push(`wrong suite: ${gate}/${name}: ${file}`);
      }
    }
  }
  return { assigned, gateCounts };
}

function validateManifestShape(manifests, gateCounts, issues) {
  for (const gate of Object.keys(gateManifests).sort()) {
    if (!(gate in manifests)) issues.push(`missing gate: ${gate}`);
  }
  for (const gate of Object.keys(manifests).sort()) {
    if (!(gate in gateManifests)) issues.push(`unknown gate: ${gate}`);
    const expectedCounts = expectedGateCounts[gate];
    const actualCounts = gateCounts[gate];
    if (expectedCounts && actualCounts.node !== expectedCounts.node) {
      issues.push(`wrong Node count: ${gate}: expected ${expectedCounts.node}, found ${actualCounts.node}`);
    }
    if (expectedCounts && actualCounts.vitest !== expectedCounts.vitest) {
      issues.push(`wrong Vitest count: ${gate}: expected ${expectedCounts.vitest}, found ${actualCounts.vitest}`);
    }
  }
  for (const name of Object.keys(partitionSuites).sort()) {
    const gate = partitionGates[name];
    if (!(name in (manifests[gate] ?? {}))) issues.push(`missing partition: ${gate}: ${name}`);
  }
}

function validateAssignments(expected, assigned, issues) {
  for (const file of [...expected].sort()) {
    const owners = assigned.get(file) ?? [];
    if (owners.length === 0) issues.push(`missing assignment: ${file}`);
    if (owners.length > 1) issues.push(`duplicate assignment (${owners.length}): ${file}: ${owners.sort().join(", ")}`);
  }
}

export function validatePartitionManifest(inventory, manifests = gateManifests) {
  const issues = [];
  const expected = new Set([...inventory.node, ...inventory.vitest]);
  const { assigned, gateCounts } = collectAssignments(inventory, manifests, expected, issues);
  validateManifestShape(manifests, gateCounts, issues);
  validateAssignments(expected, assigned, issues);
  issues.sort();
  return Object.freeze({
    counts: Object.freeze({ node: inventory.node.length, vitest: inventory.vitest.length }),
    gateCounts: Object.freeze(Object.fromEntries(
      Object.entries(gateCounts).map(([gate, counts]) => [gate, Object.freeze(counts)]),
    )),
    issues: Object.freeze(issues),
    message: issues.length === 0 ? "" : issueSummary(issues),
  });
}

export async function verifyPartitionManifest() {
  const result = validatePartitionManifest(await discoverTestInventory());
  if (result.issues.length > 0) throw new Error(result.message);
  return result;
}

export async function verifyGateManifest(gate) {
  if (!(gate in gateManifests)) throw new Error(`Unknown test gate: ${gate}`);
  const result = await verifyPartitionManifest();
  return Object.freeze({ gate, counts: result.gateCounts[gate] });
}
