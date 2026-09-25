# Composition validator final exact-SHA benchmark

This no-PR evidence harness compares base `4fe70d7` with fixed tip `e2e7933`
through built public exports. It uses Node built-ins, runs sequentially on one
non-CPU0 logical CPU, and keeps setup and correctness work outside hot timing.

After frozen installs and forced config-engine/weaver-server builds in both clean
source worktrees, run from this evidence worktree:

```sh
timeout 5400 node --expose-gc benchmarks/composition-validator/runner.mjs \
  --base /home/sprawl/projects/weaver/worktrees/pr152-b-write-validation \
  --tip /home/sprawl/projects/weaver/worktrees/bound-schema-registration \
  --seed 0xD6615EED \
  --core auto \
  --output benchmarks/composition-validator/results/raw.json
node benchmarks/composition-validator/report.mjs \
  --input benchmarks/composition-validator/results/raw.json \
  --output benchmarks/composition-validator/REPORT.md
```

Use `--preflight-only` for the untimed 126-descriptor/154-record semantic gate.
The full command times exactly 67 descriptors/83 source cases with three fresh
processes and 25 samples each. Calibration targets 100–250 ms with at least one
operation; each child then warms the final batch shape for at least five batches
and two seconds. CV and first/last-five drift are informational.

The runner permits one complete replacement only for load at or above 0.5 per
logical CPU or process-run median spread above 1.20. It never retries individual
runs. Correctness/effect/prototype/mutation failures, crash/OOM, a sample over 30
seconds, or RSS over 1 GiB are hard failures. `raw.json` is canonical evidence;
`REPORT.md` is a deterministic rendering of it.
