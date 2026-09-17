import { Readable } from "node:stream";
import { spec } from "node:test/reporters";

export function skippedNodeTest(event) {
  if (event.type !== "test:pass" || !event.data?.skip) return undefined;
  return event.data.name ?? "unnamed test";
}

export function assertNoSkippedTests(names, suite) {
  if (names.length === 0) return;
  throw new Error(`${suite} gate forbids skipped tests: ${names.join(", ")}`);
}

export default async function* noSkippedNodeTests(source) {
  const skipped = [];
  async function* inspect() {
    for await (const event of source) {
      const name = skippedNodeTest(event);
      if (name) skipped.push(name);
      yield event;
    }
  }
  yield* Readable.from(inspect()).compose(spec());
  if (skipped.length > 0) {
    yield `\nNode test gate forbids skipped tests: ${skipped.join(", ")}\n`;
    process.exitCode = 1;
  }
}
