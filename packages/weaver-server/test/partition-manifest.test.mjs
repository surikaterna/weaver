import { describe, expect, it } from "vitest";
import {
  partitionManifest,
  partitionSuites,
  validatePartitionManifest,
} from "./partition-manifest.mjs";
import { parseRunnerArgs } from "./run-test-partition.mjs";

function syntheticInventory(manifest = partitionManifest) {
  const inventory = { node: [], vitest: [] };
  for (const [name, files] of Object.entries(manifest)) {
    inventory[partitionSuites[name]].push(...files);
  }
  inventory.node.sort();
  inventory.vitest.sort();
  return inventory;
}

describe("partition manifest validation", () => {
  it("accepts an exact synthetic inventory", () => {
    const result = validatePartitionManifest(syntheticInventory());
    expect(result.issues).toEqual([]);
    expect(result.counts).toEqual({ node: 62, vitest: 39 });
    expect(Object.keys(partitionManifest)).toHaveLength(24);
  });

  it("reports every mismatch once with bounded deterministic diagnostics", () => {
    const manifest = {
      ...partitionManifest,
      "node-bootstrap": Object.freeze([
        ...partitionManifest["node-bootstrap"],
        partitionManifest["node-cli"][0],
        "test/stale.node.mjs",
      ]),
      "unknown-empty": Object.freeze([]),
    };
    const inventory = syntheticInventory();
    inventory.vitest.push("test/missing.test.mjs");
    const result = validatePartitionManifest(inventory, manifest);
    expect(result.issues).toEqual([...result.issues].sort());
    expect(result.message).toContain(`Partition manifest invalid (${result.issues.length} issues)`);
    expect(result.issues).toContain("unknown partition: unknown-empty");
    expect(result.issues).toContain("empty partition: unknown-empty");
    expect(result.issues).toContain("duplicate assignment (2): test/bootstrap-cli.node.mjs: node-bootstrap, node-cli");
    expect(result.issues).toContain("stale assignment: node-bootstrap: test/stale.node.mjs");
    expect(result.issues).toContain("missing assignment: test/missing.test.mjs");
  });

  it("identifies wrong-suite assignments", () => {
    const manifest = {
      ...partitionManifest,
      "node-cli": Object.freeze([partitionManifest["vitest-core"][0]]),
      "vitest-core": Object.freeze([
        partitionManifest["node-cli"][0],
        ...partitionManifest["vitest-core"].slice(1),
      ]),
    };
    const result = validatePartitionManifest(syntheticInventory(), manifest);
    expect(result.issues.filter((issue) => issue.startsWith("wrong suite:"))).toHaveLength(2);
  });
});

describe("partition runner arguments", () => {
  it("accepts verify or one exact known partition", () => {
    expect(parseRunnerArgs(["verify"])).toEqual({ kind: "verify" });
    expect(parseRunnerArgs(["node-cli"])).toEqual({ kind: "partition", name: "node-cli" });
  });

  it("rejects missing, extra, and unknown arguments", () => {
    expect(() => parseRunnerArgs([])).toThrow("exactly one");
    expect(() => parseRunnerArgs(["verify", "node-cli"])).toThrow("exactly one");
    expect(() => parseRunnerArgs(["all"])).toThrow("Unknown test partition");
  });
});
