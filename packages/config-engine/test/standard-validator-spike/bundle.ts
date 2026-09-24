import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { type BuildResult, build, type Metafile } from "esbuild";
import {
  fixedStandaloneSchema,
  generateStandaloneModule,
} from "./adapters/ajv-standalone.js";

const resultPath = resolve(import.meta.dirname, "results/bundle.json");
const entries = {
  baseline: resolve(import.meta.dirname, "adapters/baseline.ts"),
  cfworker: resolve(import.meta.dirname, "adapters/cfworker.ts"),
  "ajv-runtime": resolve(import.meta.dirname, "adapters/ajv-runtime.ts"),
} as const;

interface BundleMeasure {
  readonly esm: SizeMeasure;
  readonly iife: SizeMeasure;
  readonly nodeBuiltins: readonly string[];
  readonly evalTokens: readonly string[];
  readonly dynamicNoEval: boolean;
  readonly noEvalDetail: string;
  readonly metafileInputs: Readonly<Record<string, number>>;
}

interface SizeMeasure {
  readonly minifiedBytes: number;
  readonly gzipBytes: number;
  readonly combinedBytes: number;
}

const measured: Record<string, BundleMeasure> = {};
for (const [id, entry] of Object.entries(entries))
  measured[id] = await measureAdapter(id, entry);
measured["ajv-standalone"] = await measureStandalone();
const baseline = measured.baseline;
if (baseline === undefined) throw new Error("Baseline bundle missing");
const candidates = Object.fromEntries(
  Object.entries(measured).map(([id, value]) => {
    const incrementalCombinedBytes =
      id === "ajv-standalone"
        ? value.esm.combinedBytes
        : Math.max(0, value.esm.combinedBytes - baseline.esm.combinedBytes);
    return [
      id,
      {
        ...value,
        incrementalCombinedBytes,
        thresholdBytes: 75 * 1024,
        bundlePass: incrementalCombinedBytes <= 75 * 1024,
      },
    ];
  }),
);
await writeFile(
  resultPath,
  `${JSON.stringify({ schemaVersion: 1, esbuild: "0.28.2", scanPatterns: ["eval(", "new Function", "Function("], candidates }, null, 2)}\n`,
);
execFileSync("pnpm", ["exec", "biome", "format", "--write", resultPath], {
  stdio: "ignore",
});

async function measureAdapter(
  id: string,
  entry: string,
): Promise<BundleMeasure> {
  const esm = await bundle({ entryPoints: [entry], format: "esm" });
  const iife = await bundle({
    entryPoints: [entry],
    format: "iife",
    globalName: "Spike",
  });
  const code = output(iife);
  const dynamic = executeDynamic(id, code);
  return measurement(esm, iife, dynamic);
}

async function measureStandalone(): Promise<BundleMeasure> {
  const source = generateStandaloneModule(fixedStandaloneSchema());
  const options = {
    stdin: {
      contents: source,
      resolveDir: import.meta.dirname,
      sourcefile: "ajv-fixed-standalone.js",
    },
  };
  const esm = await bundle({ ...options, format: "esm" });
  const iife = await bundle({
    ...options,
    format: "iife",
    globalName: "Fixed",
  });
  const fixed = executeFixed(output(iife));
  return measurement(esm, iife, {
    pass: false,
    detail: `fixed-no-eval=${String(fixed)}; unseen registration unavailable`,
  });
}

async function bundle(
  options: Parameters<typeof build>[0],
): Promise<BuildResult<{ metafile: true; write: false }>> {
  return build({
    ...options,
    bundle: true,
    minify: true,
    metafile: true,
    write: false,
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
}

function measurement(
  esm: BuildResult<{ metafile: true; write: false }>,
  iife: BuildResult<{ metafile: true; write: false }>,
  dynamic: { readonly pass: boolean; readonly detail: string },
): BundleMeasure {
  const code = `${output(esm)}\n${output(iife)}`;
  const metafile = esm.metafile;
  return {
    esm: size(output(esm)),
    iife: size(output(iife)),
    nodeBuiltins: externalImports(metafile).filter((path) =>
      path.startsWith("node:"),
    ),
    evalTokens: ["eval(", "new Function", "Function("].filter((token) =>
      code.includes(token),
    ),
    dynamicNoEval: dynamic.pass,
    noEvalDetail: dynamic.detail,
    metafileInputs: inputContributions(metafile),
  };
}

function executeDynamic(
  id: string,
  code: string,
): { readonly pass: boolean; readonly detail: string } {
  try {
    const context = browserContext();
    runInContext(code, context, { timeout: 5_000 });
    const factory =
      id === "baseline"
        ? "createBaselineAdapter"
        : id === "cfworker"
          ? "createCfworkerAdapter"
          : "createAjvRuntimeAdapter";
    const result = runInContext(
      `(() => { const a=Spike.${factory}(); a.register("fresh", {type:"string"}); return a.validateRegistered("fresh", "ok", "partial").normalized.valid; })()`,
      context,
      { timeout: 5_000 },
    );
    return {
      pass: result === true,
      detail: `dynamic validation returned ${String(result)}`,
    };
  } catch (error: unknown) {
    return {
      pass: false,
      detail:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    };
  }
}

function executeFixed(code: string): boolean {
  try {
    const context = browserContext();
    runInContext(code, context, { timeout: 5_000 });
    return (
      runInContext("Fixed.default({name:'ok'})", context, {
        timeout: 5_000,
      }) === true
    );
  } catch {
    return false;
  }
}

function browserContext(): ReturnType<typeof createContext> {
  const quietConsole = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return createContext(
    {
      console: quietConsole,
      performance,
      URL,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
}

function output(result: BuildResult<{ write: false }>): string {
  const file = result.outputFiles[0];
  if (file === undefined) throw new Error("esbuild returned no output");
  return file.text;
}

function size(code: string): SizeMeasure {
  const minifiedBytes = Buffer.byteLength(code);
  const gzipBytes = gzipSync(code, { level: 9 }).byteLength;
  return { minifiedBytes, gzipBytes, combinedBytes: minifiedBytes + gzipBytes };
}

function externalImports(metafile: Metafile): readonly string[] {
  return [
    ...new Set(
      Object.values(metafile.inputs).flatMap((input) =>
        input.imports.filter((item) => item.external).map((item) => item.path),
      ),
    ),
  ].sort();
}

function inputContributions(
  metafile: Metafile,
): Readonly<Record<string, number>> {
  const output = Object.values(metafile.outputs)[0];
  const entries: Array<readonly [string, number]> = Object.entries(
    output?.inputs ?? {},
  ).map(([name, detail]) => [name, detail.bytesInOutput] as const);
  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}
