import { assertNoSkippedTests } from "./no-skips-node-reporter.mjs";

export function skippedVitestTest(testCase) {
  if (testCase.result().state !== "skipped") return undefined;
  return testCase.fullName ?? testCase.name ?? "unnamed test";
}

export class NoSkippedVitestReporter {
  skipped = [];

  onTestCaseResult(testCase) {
    const name = skippedVitestTest(testCase);
    if (name) this.skipped.push(name);
  }

  onTestRunEnd() {
    assertNoSkippedTests(this.skipped, "Vitest");
  }
}

export default NoSkippedVitestReporter;
