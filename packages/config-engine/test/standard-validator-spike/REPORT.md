# RETAIN — no qualifying standard validator

Neither candidate clears the frozen correctness/security gates. Keep the verified Weaver validator at base `4fe70d70762460d6656641bfa775121c4ffae058`; do not implement a production replacement from this spike.

## Executive verdict

- **@cfworker/json-schema 4.1.1:** RETAIN. 53/65; deterministic error-path differences and depth-5000 stack overflow are hard failures.
- **Ajv runtime 8.20.0:** RETAIN. 61/65; exact-decimal parity, depth-5000, and no-eval dynamic compilation fail.
- **Ajv standalone 8.20.0:** fixed schemas work without eval, but unseen runtime schemas cannot be registered; standalone alone is ineligible by rule.
- Performance was not measured for failed candidates, exactly as the frozen stop rule requires.

## Frozen-rubric pass/fail

| Rule | cfworker | Ajv runtime | Ajv standalone |
|---|---:|---:|---:|
| 100% admitted validity + normalized code/path/order | FAIL (53/65) | FAIL (61/65) | FAIL (2/65) |
| Mutation/prototype/cycle/sparse safety | FAIL (depth) | FAIL (depth) | FAIL (dynamic) |
| Dynamic browser schema under no-eval | PASS | FAIL | FAIL (fixed only) |
| No Node built-ins | PASS | PASS | PASS |
| No eval/Function token | PASS | FAIL | PASS |
| <=75 KiB minified+gzip | PASS (35.3 KiB) | FAIL (167.1 KiB) | PASS (2.3 KiB) |
| No high/critical advisory; compatible license | PASS | PASS | PASS |
| Performance thresholds | NOT RUN (ineligible) | NOT RUN (ineligible) | NOT RUN (ineligible) |
| Hybrid >=25% and 200 LOC | FAIL (-170, -12.3%) | FAIL (-172, -12.5%) | FAIL (-124, -9%) |
| Adopt >=60% and 500 LOC | FAIL | FAIL | FAIL |

## Key raw deltas

- cfworker failed: required-effective, closed-default, additional-false, additional-typed-invalid, pattern-properties-overlap-invalid, array-items-invalid, unique-items, default-partial, inherited-value-member, mutation-invalid, deterministic-error-order, depth-5000. Its depth-5000 constructor throws `RangeError`; raw engine errors are retained in `results/matrix.json`.
- Ajv runtime failed: multiple-decimal, multiple-invalid-schema, unique-items, inherited-value-member, depth-5000. In particular, `0.3 / 0.1` differs from Weaver exact-decimal policy and depth-5000 compilation throws.
- Ajv standalone validates one build-time fixture under a no-code-generation VM, but the dynamic unseen-schema row fails by construction.
- Composition capability is separately proven for oneOf without admitting composition into Weaver's current profile.

## Ownership boundary

Candidates were credited only for ordinary keyword evaluation. Weaver-retained layers are profile/mode lowering, closed-default policy, effective default shadow, patch/member resolution, schema/value graph and sparse checks, regex policy, exact-decimal policy, x-weaver policy, and deterministic error normalization. Lowering preserves absent, boolean, and schema-valued additionalProperties; the explicit-false row rejects an unknown own member across the baseline and applicable candidates. Raw candidate errors remain beside normalized results.

## Performance, bundles, dependencies, and LOC

The benchmark configuration discloses seed 1592636971, 20/100 compile warmup/samples and 5/30 hot batches, but all candidates are marked ineligible before timing. Browser bundle artifacts own the shipped-size gate: `results/bundle.json` records raw, minified, gzip, and metafile evidence under the unchanged <=75 KiB rule. Installed filesystem totals are excluded because package-manager layout is not shipped-size evidence. Dependency closure is 1 package for cfworker and 5 for Ajv; all licenses are MIT or BSD-3-Clause. A separate live `pnpm audit --json` gate filters the exact declared closure and requires zero attributable high/critical advisories without adding registry data to hashed artifacts. LOC projections are cfworker fail (-170, -12.3%); ajv-runtime fail (-172, -12.5%); ajv-standalone fail (-124, -9%).

## Defaults, mutation, and adversarial evidence

Ajv mutation options and equivalent behavior are disabled. Annotation-only partial runs do not materialize defaults. The candidate-neutral iterative effective shadow supplies Weaver-consulted absent and own-undefined child defaults while descriptor/identity checks preserve originals. Sparse arrays and cycles are rejected by the retained B preflight. Child probes run with 5s and 512 MiB limits.

## Limitations

This is a bounded decision spike, not a full JSON Schema Test Suite run. The shared corpus has 66 explicit rows and compares deterministic public validity/code/path/order while retaining full raw and normalized messages. Candidate error vocabularies do not always expose enough parameters for exact Weaver paths. Browser execution uses Node's VM with string/wasm generation disabled rather than a physical browser. Timing is intentionally absent after hard-gate failure.

## Bounds and test impact

Handwritten scope is 18 files / 2479 nonblank LOC, within the 18-file limit and below the 2485-LOC investigation marker and 2500-LOC stop. Existing 73 config-engine and 24 server write-pipeline tests remain necessary because no candidate qualifies. Changeset status intentionally exits 1 with "Some packages have been changed but no changesets were found" because this non-mergeable test-only evidence lives under config-engine; no changeset is appropriate. No production source, existing test, public contract, changeset, or PR was changed.

## Artifact SHA-256

- `benchmark.json`: `5b64f22b551748df2e14b1dd99d6db3072fd8b3371a7e4fdb0844a1faf098d54`
- `bundle.json`: `38c1286e5b7c8be45bf202843ec2362d43fdcf03c162d4731db546319b2c2edf`
- `dependencies.json`: `f1d720cea6a5b95fcad2d3b765e0a67a36fd4cc57437a003cde7b1d471530d20`
- `environment.json`: `dc820cc08819fe58025db7e8ff7d7f075fbf1e7508c532c362a62dd300169d90`
- `loc.json`: `e79b9748207b149186bcb037268dd11e754c6e2948ade7f8d29c60fc80a418b6`
- `matrix.json`: `271463490b3ce78f97c7198383d1678d77a0fddaab0ca8498a133c0420f5537c`

## Recommended production decision

Retain B unchanged and unblock its existing release flow after independent audit of this evidence. If reconsidered later, investigate an iterative interpreter with richer structured errors; do not use Ajv runtime under Weaver's no-eval dynamic-registration requirement or standalone as a universal registry.
