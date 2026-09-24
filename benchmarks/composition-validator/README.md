# Composition validator exact-SHA benchmark

This opt-in evidence harness compares the frozen pre-composition base with the
fixed composition tip `e2e79332572261ec526475f40f2ebf08a7f17cdd`. It does not
import source internals or add timing checks to CI.

After installing and building both clean source worktrees as specified in
`weaver-vxw2`, run from this evidence worktree:

```sh
timeout 7200 node --expose-gc benchmarks/composition-validator/runner.mjs \
  --base /home/sprawl/projects/weaver/worktrees/pr152-b-write-validation \
  --tip /home/sprawl/projects/weaver/worktrees/bound-schema-registration \
  --seed 0xD6615EED \
  --core auto \
  --output benchmarks/composition-validator/results/raw.json
node benchmarks/composition-validator/report.mjs \
  --input benchmarks/composition-validator/results/raw.json \
  --output benchmarks/composition-validator/REPORT.md
```

The seed is frozen at `0xD6615EED`. `--core auto` selects the first CPU in the
current affinity and launches workers through `taskset`; use `--core N` to
select another allowed core or `--core none` only where `taskset` is absent.
The runner rejects wrong SHAs or dirty source worktrees. It records 3 runs × 25
samples for every matrix case and permits at most two complete replacement sets
when the frozen 5% stability checks reject a set. Setup and correctness hashing
are outside the hot timing interval. `results/raw.json` is the complete evidence;
`REPORT.md` is deterministic derivation using the frozen issue thresholds.
An immediate correctness, crash/OOM, 30-second-sample, or 1 GiB RSS safety
failure stops the matrix and must be reported as incomplete rather than dropping
or shrinking the failing case.

Memory measurements are observational process RSS/heap snapshots. Explicit GC
reduces cross-sample residue but does not make these allocation measurements.
