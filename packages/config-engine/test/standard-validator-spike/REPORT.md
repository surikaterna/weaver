# RETAIN — no qualifying standard validator

Neither candidate clears the frozen correctness/security gates. Keep the verified Weaver validator at base `4fe70d70762460d6656641bfa775121c4ffae058`; do not implement a production replacement from this spike.

## Executive verdict

- **@cfworker/json-schema 4.1.1:** RETAIN. 52/63; deterministic error-path differences and depth-5000 stack overflow are hard failures.
- **Ajv runtime 8.20.0:** RETAIN. 59/63; exact-decimal parity, depth-5000, and no-eval dynamic compilation fail.
- **Ajv standalone 8.20.0:** fixed schemas work without eval, but unseen runtime schemas cannot be registered; standalone alone is ineligible by rule.
- Performance was not measured for failed candidates, exactly as the frozen stop rule requires.

## Frozen-rubric pass/fail

| Rule | cfworker | Ajv runtime | Ajv standalone |
|---|---:|---:|---:|
| 100% admitted validity + normalized code/path/order | FAIL (52/63) | FAIL (59/63) | FAIL (2/63) |
| Mutation/prototype/cycle/sparse safety | FAIL (depth) | FAIL (depth) | FAIL (dynamic) |
| Dynamic browser schema under no-eval | PASS | FAIL | FAIL (fixed only) |
| No Node built-ins | PASS | PASS | PASS |
| No eval/Function token | PASS | FAIL | PASS |
| <=75 KiB minified+gzip | PASS (35.1 KiB) | FAIL (166.9 KiB) | PASS (2.3 KiB) |
| No high/critical advisory; compatible license | PASS | PASS | PASS |
| Performance thresholds | NOT RUN (ineligible) | NOT RUN (ineligible) | NOT RUN (ineligible) |
| Hybrid >=25% and 200 LOC | FAIL (-164, -11.9%) | FAIL (-166, -12%) | FAIL (-118, -8.5%) |
| Adopt >=60% and 500 LOC | FAIL | FAIL | FAIL |

## Key raw deltas

- cfworker failed: required-effective, closed-default, additional-typed-invalid, pattern-properties-overlap-invalid, array-items-invalid, unique-items, default-partial, inherited-value-member, mutation-invalid, deterministic-error-order, depth-5000. Its depth-5000 constructor throws `RangeError`; raw engine errors are retained in `results/matrix.json`.
- Ajv runtime failed: multiple-decimal, multiple-invalid-schema, unique-items, inherited-value-member, depth-5000. In particular, `0.3 / 0.1` differs from Weaver exact-decimal policy and depth-5000 compilation throws.
- Ajv standalone validates one build-time fixture under a no-code-generation VM, but the dynamic unseen-schema row fails by construction.
- Composition capability is separately proven for oneOf without admitting composition into Weaver's current profile.

## Ownership boundary

Candidates were credited only for ordinary keyword evaluation. Weaver-retained layers are profile/mode lowering, closed-default policy, effective default shadow, patch/member resolution, schema/value graph and sparse checks, regex policy, exact-decimal policy, x-weaver policy, and deterministic error normalization. Raw candidate errors remain beside normalized results.

## Performance, bundles, dependencies, and LOC

The benchmark configuration discloses seed 1592636971, 20/100 compile warmup/samples and 5/30 hot batches, but all candidates are marked ineligible before timing. Bundle sizes and metafile contributions are in `results/bundle.json`. Dependency closure is 1 package for cfworker and 5 for Ajv; all licenses are MIT or BSD-3-Clause, with no attributable high/critical advisory. LOC projections are cfworker fail (-164, -11.9%); ajv-runtime fail (-166, -12%); ajv-standalone fail (-118, -8.5%).

## Defaults, mutation, and adversarial evidence

Ajv mutation options and equivalent behavior are disabled. Annotation-only partial runs do not materialize defaults. The candidate-neutral iterative effective shadow supplies only Weaver-consulted defaults while descriptor/identity checks preserve originals. Sparse arrays and cycles are rejected by the retained B preflight. Child probes run with 5s and 512 MiB limits.

## Limitations

This is a bounded decision spike, not a full JSON Schema Test Suite run. The shared corpus has 64 explicit rows and compares deterministic public validity/code/path/order while retaining full raw and normalized messages. Candidate error vocabularies do not always expose enough parameters for exact Weaver paths. Browser execution uses Node's VM with string/wasm generation disabled rather than a physical browser. Timing is intentionally absent after hard-gate failure.

## Bounds and test impact

Handwritten scope is 18 files / 2485 nonblank LOC: the 12-file/1800-LOC investigation marker was reached, but the 18-file/2500-LOC stop was not exceeded. Existing 73 config-engine and 24 server write-pipeline tests remain necessary because no candidate qualifies. No production source, existing test, public contract, changeset, or PR was changed.

## Artifact SHA-256

- `benchmark.json`: `93c00bc372b41c6d87f869c2e5420ca6cfb33f7fc94afdb00271c3ca8ba5c16e`
- `bundle.json`: `3dd9214c0daa2d8e2b3022c750a7abafab5bc32b0e2878e06137a6978c70d93a`
- `dependencies.json`: `bef2091c5c9320bdb07bdf677215731812ec4e62bb46923f6acba6436ab700b7`
- `environment.json`: `dc820cc08819fe58025db7e8ff7d7f075fbf1e7508c532c362a62dd300169d90`
- `loc.json`: `5ff1a314c64181664ce4baec182a01036e9715e48c079778ecb52c62bcc34a6a`
- `matrix.json`: `8c59331890cd578a23825f170317f117ecc486ac0d35d5ae6ff6490d674f4c90`

## Recommended production decision

Retain B unchanged and unblock its existing release flow after independent audit of this evidence. If reconsidered later, investigate an iterative interpreter with richer structured errors; do not use Ajv runtime under Weaver's no-eval dynamic-registration requirement or standalone as a universal registry.
