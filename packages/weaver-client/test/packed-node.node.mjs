import { rm } from "node:fs/promises";
import test from "node:test";
import { bootFixture, browserExports, fixture, installConsumer, run, snapshot } from "./packed-consumer-helper.mjs";

const filesystemProof = `
const fs = await import("node:fs/promises");
const path = await import("node:path");
const directory = path.join(process.cwd(), "real-cache");
const persistence = api.createFileSystemPersistence({ directory });
const snapshot = ${JSON.stringify(snapshot)};
assert.equal(await persistence.load("missing"), null);
await persistence.save("app", snapshot);
assert.deepEqual(await persistence.load("app"), snapshot);
assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "app.json"), "utf8")), snapshot);
assert.deepEqual(await fs.readdir(directory), ["app.json"]);
const next = { ...snapshot, revision: "packed-2" };
await persistence.save("app", next);
assert.deepEqual(await persistence.load("app"), next);
assert.deepEqual(await fs.readdir(directory), ["app.json"]);
await assert.rejects(persistence.save("app", { ...snapshot, invalid: 1n }), TypeError);
assert.deepEqual(await persistence.load("app"), next);
await fs.writeFile(path.join(directory, "bad.json"), "{");
await assert.rejects(persistence.load("bad"), SyntaxError);
await fs.writeFile(path.join(directory, "invalid.json"), "{}");
await assert.rejects(persistence.load("invalid"));
await fs.mkdir(path.join(directory, "blocked.json"));
await assert.rejects(persistence.save("blocked", snapshot), { code: "EISDIR" });
assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "blocked.json.tmp"), "utf8")), snapshot);
await fs.writeFile(path.join(directory, "not-a-directory"), "file");
const invalid = api.createFileSystemPersistence({ directory: path.join(directory, "not-a-directory") });
await assert.rejects(invalid.save("app", snapshot), { code: "EEXIST" });
console.log("real filesystem: temp+rename replacement, save/load, missing/corrupt/schema/serialization/rename/mkdir errors passed");
await fs.rm(directory, { recursive: true, force: true });
`;

test("packed Node root retains real atomic filesystem persistence in ESM and CJS", async () => {
  const directory = await installConsumer();
  try {
    for (const [extension, statement] of [
      ["mjs", 'import * as api from "@weaver-conf/weaver-client"; import * as browser from "@weaver-conf/weaver-client/browser";'],
      ["cjs", 'const api = require("@weaver-conf/weaver-client"); const browser = require("@weaver-conf/weaver-client/browser");'],
    ]) {
      const file = await fixture(directory, `node-root.${extension}`, `${statement}
(async () => {
const assert = await import("node:assert/strict");
assert.deepEqual(Object.keys(api).filter(key => key !== "createFileSystemPersistence").sort(), Object.keys(browser).sort());
assert.deepEqual(Object.keys(browser).sort(), ${JSON.stringify(browserExports)});
assert.equal(typeof api.createFileSystemPersistence, "function");
console.log("Node root export parity: " + JSON.stringify(Object.keys(api).sort()));
${bootFixture}
${filesystemProof}
})().catch(error => { console.error(error); process.exitCode = 1; });`);
      console.log(run(process.execPath, [file], directory));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
