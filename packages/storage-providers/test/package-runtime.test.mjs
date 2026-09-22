import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("package barrel loads non-Mongo providers when mongodb is unresolvable", () => {
  const barrel = resolve("dist/index.cjs");
  const esmBarrel = readFileSync(resolve("dist/index.js"), "utf8");
  const script = `
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "mongodb") throw new Error("mongodb must stay optional");
      return originalLoad.call(this, request, parent, isMain);
    };
    const providers = require(process.argv[1]);
    const provider = providers.createInMemoryStorageProvider({
      id: "memory",
      layer: "platform",
      initialEntries: { available: true },
    });
    provider.load().then((loaded) => {
      if (loaded.entries.available !== true) process.exitCode = 2;
    });
  `;

  const result = spawnSync(process.execPath, ["--eval", script, barrel], {
    encoding: "utf8",
  });

  expect(esmBarrel).not.toMatch(/(?:from\s*["']mongodb|import\(["']mongodb)/);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
});
