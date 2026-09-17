import { test } from "node:test";

const mode = process.env.NODE_REPORTER_FIXTURE;

if (mode === "skip") {
  test("node skip", { skip: true }, () => {});
} else if (mode === "todo") {
  test("node todo", { todo: true }, () => {});
} else if (mode === "pending") {
  test("node pending", { todo: "pending implementation" }, () => {});
} else {
  throw new Error(`Unknown reporter fixture mode: ${mode}`);
}
