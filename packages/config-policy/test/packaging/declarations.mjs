import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertInstalled, toolRequire } from "./consumer.mjs";

const ts = toolRequire("typescript");
const types = [
  "OverrideTracker", "OverrideTrackerOptions", "PolicyDecision", "PolicyEvaluationContext",
  "PolicyViolation", "CustomRatchetRule", "OrderedRatchetRule", "RatchetEvaluation",
  "RatchetLayerSnapshot", "RatchetRule", "RatchetTransition", "RatchetValidationResult", "RatchetValidatorOptions",
];

function fixture() {
  return `import type { ${types.join(", ")} } from '@weaver-conf/config-policy/browser';
export type Surface = [${types.join(", ")}];
import { createInMemoryOverrideTracker, evaluateChangePolicy, validateChangePolicies,
  DEFAULT_PLUGIN_MANAGEMENT_RATCHET_RULES, validateOneWayRatchet } from '@weaver-conf/config-policy/browser';
const tracker: OverrideTracker = createInMemoryOverrideTracker({ followUpDeadlineMs: 1000 });
const decision: PolicyDecision = evaluateChangePolicy({type: 'string'}, {userId: 'ops', roles: []}, 'app', () => true);
const findings: PolicyViolation[] = validateChangePolicies(new Map());
const result: RatchetValidationResult = validateOneWayRatchet([], DEFAULT_PLUGIN_MANAGEMENT_RATCHET_RULES, {layerOrder: []});
// @ts-expect-error The filesystem factory is intentionally Node-root-only.
import { createFileSystemOverrideTracker as forbidden } from '@weaver-conf/config-policy/browser';
import { createFileSystemOverrideTracker } from '@weaver-conf/config-policy';
const filesystem: OverrideTracker = createFileSystemOverrideTracker('./records.json', {followUpDeadlineMs: 1000});
`;
}

export async function checkDeclarations(consumer, mode) {
    const extension = mode === "cjs" ? "cts" : "mts";
    const path = join(consumer, `${mode}.${extension}`);
    await writeFile(path, fixture());
    const browser = mode === "browser";
    const options = {
      strict: true, skipLibCheck: false, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: browser ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
      moduleResolution: browser ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
      types: [],
    };
    const resolved = ts.resolveModuleName("@weaver-conf/config-policy/browser", path, options, ts.sys,
      undefined, undefined, mode === "cjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext).resolvedModule;
    assert.ok(resolved);
    await assertInstalled(resolved.resolvedFileName, consumer);
    assert.ok(resolved.resolvedFileName.endsWith(mode === "cjs" ? "browser.d.cts" : "browser.d.ts"));
    const program = ts.createProgram([path], options);
    for (const source of program.getSourceFiles()) {
      if (source.fileName.includes("@weaver-conf")) await assertInstalled(source.fileName, consumer);
    }
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const text = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name, getCurrentDirectory: () => consumer, getNewLine: () => "\n",
    });
    assert.equal(diagnostics.length, 0, text);
}
