import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  defaultPartitionManifest,
  discoverTestInventory,
  gateManifests,
  livePartitionManifest,
  partitionManifest,
  partitionSuites,
  validatePartitionManifest,
} from "./partition-manifest.mjs";
import {
  assertNoSkippedTests,
  skippedNodeTest,
} from "./no-skips-node-reporter.mjs";
import {
  NoSkippedVitestReporter,
  skippedVitestTest,
} from "./no-skips-vitest-reporter.mjs";
import {
  assertDistinctAuthorities,
  assertMongoTopology,
  readLiveMongoUris,
} from "./live-mongo-preflight.mjs";
import { parseRunnerArgs } from "./run-test-partition.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const mongoEnvironment = ["WEAVER_TEST_MONGO_URI", "WEAVER_TEST_MONGO_STANDALONE_URI"];

function syntheticInventory(manifests = gateManifests) {
  const inventory = { node: [], vitest: [] };
  for (const manifest of Object.values(manifests)) {
    for (const [name, files] of Object.entries(manifest)) {
      const suite = partitionSuites[name];
      if (suite) inventory[suite].push(...files);
    }
  }
  inventory.node.sort();
  inventory.vitest.sort();
  return inventory;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function partitionScripts(manifest) {
  return Object.keys(manifest).sort().map((name) => `test:${name}`);
}

function expectPartitionScripts(packageJson, manifest) {
  for (const name of Object.keys(manifest)) {
    expect(packageJson.scripts[`test:${name}`]).toBe(`node test/run-test-partition.mjs ${name}`);
  }
}

function expectDefaultTurboTasks(tasks) {
  const expected = partitionScripts(defaultPartitionManifest);
  expect([...tasks["@weaver-conf/weaver-server#test"].dependsOn].sort()).toEqual(expected);
  expect(tasks["@weaver-conf/weaver-server#test"]).toMatchObject({ cache: false });
  expect(tasks["@weaver-conf/weaver-server#test"].env).toBeUndefined();
  for (const name of Object.keys(defaultPartitionManifest)) {
    expect(tasks[`test:${name}`]).toMatchObject({
      cache: false,
      dependsOn: [name === "node-cli" ? "build" : "^build"],
    });
    expect(tasks[`test:${name}`].env).toBeUndefined();
  }
}

function expectLiveTurboTasks(tasks) {
  const expected = partitionScripts(livePartitionManifest);
  const aggregate = tasks["@weaver-conf/weaver-server#test:live-mongo"];
  expect([...aggregate.dependsOn].sort()).toEqual(expected);
  expect(aggregate).toMatchObject({ cache: false, env: mongoEnvironment });
  expect(tasks["test:live-mongo:preflight"]).toMatchObject({ cache: false, env: mongoEnvironment });
  for (const name of Object.keys(livePartitionManifest)) {
    expect(tasks[`test:${name}`]).toMatchObject({
      cache: false,
      dependsOn: ["^build", "test:live-mongo:preflight"],
      env: mongoEnvironment,
    });
  }
}

describe("partition manifest validation", () => {
  it("preserves exact per-gate counts, disjointness, and union", () => {
    const result = validatePartitionManifest(syntheticInventory());
    const defaultFiles = new Set(Object.values(defaultPartitionManifest).flat());
    const liveFiles = new Set(Object.values(livePartitionManifest).flat());
    expect(result.issues).toEqual([]);
    expect(result.counts).toEqual({ node: 62, vitest: 39 });
    expect(result.gateCounts).toEqual({ default: { node: 59, vitest: 39 }, live: { node: 3, vitest: 0 } });
    expect([...defaultFiles].filter((file) => liveFiles.has(file))).toEqual([]);
    expect(new Set([...defaultFiles, ...liveFiles]).size).toBe(101);
    expect(Object.keys(partitionManifest)).toHaveLength(24);
  });

  it("matches the complete discovered inventory", async () => {
    const inventory = await discoverTestInventory();
    const result = validatePartitionManifest(inventory);
    expect(result.issues).toEqual([]);
    expect(result.counts).toEqual({ node: 62, vitest: 39 });
  });

  it("reports every mismatch once with bounded deterministic diagnostics", () => {
    const manifests = {
      ...gateManifests,
      default: {
        ...defaultPartitionManifest,
        "node-bootstrap": Object.freeze([
          ...defaultPartitionManifest["node-bootstrap"],
          defaultPartitionManifest["node-cli"][0],
          "test/stale.node.mjs",
        ]),
        "unknown-empty": Object.freeze([]),
      },
    };
    const inventory = syntheticInventory();
    inventory.vitest.push("test/missing.test.mjs");
    const result = validatePartitionManifest(inventory, manifests);
    expect(result.issues).toEqual([...result.issues].sort());
    expect(result.message).toContain(`Partition manifest invalid (${result.issues.length} issues)`);
    expect(result.issues).toContain("unknown partition: default: unknown-empty");
    expect(result.issues).toContain("empty partition: default: unknown-empty");
    expect(result.issues).toContain("duplicate assignment (2): test/bootstrap-cli.node.mjs: default/node-bootstrap, default/node-cli");
    expect(result.issues).toContain("stale assignment: default/node-bootstrap: test/stale.node.mjs");
    expect(result.issues).toContain("missing assignment: test/missing.test.mjs");
  });

  it("identifies wrong-suite assignments", () => {
    const manifests = {
      ...gateManifests,
      default: {
        ...defaultPartitionManifest,
        "node-cli": Object.freeze([defaultPartitionManifest["vitest-core"][0]]),
        "vitest-core": Object.freeze([
          defaultPartitionManifest["node-cli"][0],
          ...defaultPartitionManifest["vitest-core"].slice(1),
        ]),
      },
    };
    const result = validatePartitionManifest(syntheticInventory(), manifests);
    expect(result.issues.filter((issue) => issue.startsWith("wrong suite:"))).toHaveLength(2);
  });
});

describe("partition runner arguments", () => {
  it("accepts verification commands or one exact known partition", () => {
    expect(parseRunnerArgs(["verify-all"])).toEqual({ kind: "verify-all" });
    expect(parseRunnerArgs(["verify-default"])).toEqual({ kind: "verify-gate", gate: "default" });
    expect(parseRunnerArgs(["verify-live"])).toEqual({ kind: "verify-gate", gate: "live" });
    expect(parseRunnerArgs(["node-cli"])).toEqual({ kind: "partition", name: "node-cli" });
  });

  it("rejects missing, extra, and unknown arguments", () => {
    expect(() => parseRunnerArgs([])).toThrow("exactly one");
    expect(() => parseRunnerArgs(["verify-all", "node-cli"])).toThrow("exactly one");
    expect(() => parseRunnerArgs(["all"])).toThrow("Unknown test partition");
  });
});

describe("no-skip reporters", () => {
  it("recognizes Node and Vitest runtime skips and makes them fatal", () => {
    expect(skippedNodeTest({ type: "test:pass", data: { name: "node skip", skip: true } })).toBe("node skip");
    expect(skippedNodeTest({ type: "test:pass", data: { name: "node todo", todo: true } })).toBe("node todo");
    expect(skippedNodeTest({ type: "test:pass", data: { name: "node pending", pending: true } })).toBe("node pending");
    const testCase = { fullName: "vitest skip", result: () => ({ state: "skipped" }) };
    expect(skippedVitestTest(testCase)).toBe("vitest skip");
    expect(() => assertNoSkippedTests(["node skip"], "Node test")).toThrow("forbids skipped tests");
    const reporter = new NoSkippedVitestReporter();
    reporter.onTestCaseResult(testCase);
    expect(() => reporter.onTestRunEnd()).toThrow("vitest skip");
  });

  it.each(["skip", "todo", "pending"])("makes an executable Node %s test fatal", (mode) => {
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=./test/no-skips-node-reporter.mjs", "test/no-skips-node-reporter.fixture.mjs"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, NODE_REPORTER_FIXTURE: mode },
      },
    );
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(`node ${mode}`);
  });
});

describe("live Mongo preflight validation", () => {
  it("requires both named variables, distinct authorities, and exact topologies", () => {
    expect(() => readLiveMongoUris({})).toThrow("WEAVER_TEST_MONGO_URI is required");
    expect(() => readLiveMongoUris({ WEAVER_TEST_MONGO_URI: "mongodb://replica:27017" })).toThrow("WEAVER_TEST_MONGO_STANDALONE_URI is required");
    expect(() => assertDistinctAuthorities("mongodb://same:27017", "mongodb://same:27017")).toThrow("distinct");
    expect(() => assertMongoTopology("replica-set", { isWritablePrimary: true })).toThrow("replica set");
    expect(() => assertMongoTopology("standalone", { setName: "rs0" })).toThrow("standalone");
    expect(() => assertMongoTopology("standalone", { msg: "isdbgrid" })).toThrow("standalone");
    expect(() => assertMongoTopology("replica-set", { setName: "rs0" })).not.toThrow();
    expect(() => assertMongoTopology("standalone", { isWritablePrimary: true })).not.toThrow();
  });
});

describe("package and Turbo gate mapping", () => {
  it("maps every partition and aggregate script exactly", async () => {
    const packageJson = await readJson(path.join(packageRoot, "package.json"));
    expectPartitionScripts(packageJson, partitionManifest);
    expect(packageJson.scripts.test).toBe("node test/run-test-partition.mjs verify-default");
    expect(packageJson.scripts["test:manifest"]).toBe("node test/run-test-partition.mjs verify-all");
    expect(packageJson.scripts["test:live-mongo"]).toBe("node test/run-test-partition.mjs verify-live");
    expect(packageJson.scripts["test:live-mongo:preflight"]).toBe("node test/live-mongo-preflight.mjs");
  });

  it("keeps default and live Turbo graphs disjoint and non-cacheable", async () => {
    const turbo = await readJson(path.join(repoRoot, "turbo.json"));
    expectDefaultTurboTasks(turbo.tasks);
    expectLiveTurboTasks(turbo.tasks);
  });
});
