import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, readFile, writeFile, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createStandaloneFixture, testAdmin, testJwt } from "./standalone-fixture.ts";

const execute = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url).pathname;
function environment() { return { ...process.env, WEAVER_CREDENTIAL_administrator: testAdmin, WEAVER_CREDENTIAL_jwt: testJwt, WEAVER_ADMIN_CREDENTIAL: testAdmin }; }
async function run(args, env = environment()) { return execute(process.execPath, [cli, ...args], { timeout: 30_000, env }); }
async function files(fixture) {
  const seed = join(fixture.directory, "seed.json");
  const input = join(fixture.directory, "initialize.json");
  await writeFile(seed, JSON.stringify(fixture.seed), { mode: 0o600 });
  await writeFile(input, JSON.stringify(fixture.request), { mode: 0o600 });
  return { seed, input };
}
function startChild(seed, env) {
  const child = spawn(process.execPath, [cli, "start", seed], { env, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    let text = "";
    let errors = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`CLI start deadline: ${errors}`)); }, 30_000);
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.stdout.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(text.split("\n")[0])); } catch (error) { reject(error); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`CLI exited ${code}: ${errors}`)); });
  });
  return { child, ready, async close() {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { return await closed; } finally { clearTimeout(timer); }
  } };
}

test("qkmd bounded CLI explicit initialize/inspect/validate/start uses the real runtime and closes", { timeout: 120_000 }, async () => {
  const fixture = await createStandaloneFixture();
  let running;
  try {
    const paths = await files(fixture);
    await assert.rejects(run(["start", paths.seed]));
    assert.equal(JSON.parse((await run(["initialize", paths.seed, paths.input])).stdout).state, "initialized");
    assert.equal(JSON.parse((await run(["inspect", paths.seed])).stdout).state, "configured");
    assert.equal(JSON.parse((await run(["validate", paths.seed])).stdout).state, "ready");
    running = startChild(paths.seed, { ...environment(), WEAVER_PORT: "1", WEAVER_CONFIG_REPO: "ignored-obsolete-input" });
    const started = await running.ready;
    assert.equal(started.port, fixture.request.generation.server.port);
    assert.equal((await fetch(`http://127.0.0.1:${started.port}/readyz`, { signal: AbortSignal.timeout(30_000) })).status, 200);
    assert.deepEqual(await running.close(), { code: 0, signal: null });
    running = undefined;
    assert.equal(JSON.parse((await run(["validate", paths.seed])).stdout).state, "ready");
    const persisted = await readFile(fixture.seed.store.locator.filePath, "utf8");
    assert.ok(!persisted.includes(testAdmin));
    assert.ok(!persisted.includes(testJwt));
    await assert.rejects(run(["initialize", paths.seed, paths.input]));
  } finally { if (running) await running.close(); await fixture.dispose(); }
});

test("qkmd CLI rejects unsafe seed permissions, malformed seed and wrong administrator proof", { timeout: 120_000 }, async () => {
  const fixture = await createStandaloneFixture();
  try {
    const paths = await files(fixture);
    await chmod(paths.seed, 0o644);
    await assert.rejects(run(["inspect", paths.seed]), (error) => error.stderr.includes("FORBIDDEN"));
    await chmod(paths.seed, 0o600);
    await assert.rejects(run(["initialize", paths.seed, paths.input], { ...environment(), WEAVER_ADMIN_CREDENTIAL: "admin" }), (error) => error.stderr.includes("UNAUTHORIZED"));
    await writeFile(paths.seed, "not JSON");
    await assert.rejects(run(["start", paths.seed]), (error) => error.stderr.includes("VALIDATION_ERROR"));
  } finally { await fixture.dispose(); }
});

test("dzb8 built CLI rejects FIFO seed and initialization inputs promptly without a writer or forced kill", { timeout: 30_000 }, async (context) => {
  const fixture = await createStandaloneFixture();
  try {
    const paths = await files(fixture);
    const fifo = join(fixture.directory, "input.pipe");
    await execute("mkfifo", ["-m", "600", fifo], { timeout: 5000 });
    for (const args of [["inspect", fifo], ["initialize", paths.seed, fifo]]) {
      const started = performance.now();
      await assert.rejects(execute(process.execPath, [cli, ...args], { env: environment(), timeout: 5000, killSignal: "SIGKILL" }), (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.killed, false);
        assert.equal(error.signal, null);
        assert.match(error.stderr, /FORBIDDEN/);
        return true;
      });
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 5000);
      context.diagnostic(`dzb8 ${args[0]} FIFO refused in ${elapsed.toFixed(1)}ms; no forced kill`);
    }
    assert.deepEqual((await readdir(fixture.directory)).sort(), ["initialize.json", "input.pipe", "seed.json"]);
  } finally { await fixture.dispose(); }
});

test("dzb8 built CLI retains symlink and oversized private-file refusals", { timeout: 30_000 }, async () => {
  const fixture = await createStandaloneFixture();
  try {
    const paths = await files(fixture);
    const link = join(fixture.directory, "seed.link");
    await symlink(paths.seed, link);
    await assert.rejects(run(["inspect", link]));
    await writeFile(paths.seed, " ".repeat(65_537));
    await assert.rejects(run(["inspect", paths.seed]), (error) => error.stderr.includes("FORBIDDEN"));
    await writeFile(paths.seed, JSON.stringify(fixture.seed));
    await writeFile(paths.input, " ".repeat(4_194_305));
    await assert.rejects(run(["initialize", paths.seed, paths.input]), (error) => error.stderr.includes("FORBIDDEN"));
    assert.deepEqual((await readdir(fixture.directory)).sort(), ["initialize.json", "seed.json", "seed.link"]);
  } finally { await fixture.dispose(); }
});
