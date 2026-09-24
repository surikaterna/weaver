import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const script = resolve(import.meta.dirname, "run-matrix.ts");
const probes = [
  ["baseline", "depth-5000"],
  ["cfworker", "depth-5000"],
  ["ajv-runtime", "depth-5000"],
  ["baseline", "cyclic-value"],
  ["cfworker", "cyclic-value"],
  ["ajv-runtime", "cyclic-value"],
] as const;

test("adversarial probes terminate under the frozen process limits", async () => {
  for (const [adapter, fixture] of probes) {
    const result = await childProbe(adapter, fixture);
    assert.equal(result.timedOut, false, `${adapter}/${fixture} timed out`);
    assert.equal(
      result.signal,
      null,
      `${adapter}/${fixture} was killed by ${result.signal}`,
    );
    assert.equal(result.code, 0, `${adapter}/${fixture}: ${result.stderr}`);
    schemaShape(JSON.parse(result.stdout) as unknown);
  }
});

function childProbe(adapter: string, fixture: string): Promise<ProbeResult> {
  return new Promise((resolveProbe) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", script, "--probe", adapter, fixture],
      {
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=512" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveProbe({ code, signal, stdout, stderr, timedOut });
    });
  });
}

interface ProbeResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function schemaShape(value: unknown): void {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
}
