# Composition validator protocol-v2 benchmark

This opt-in, no-PR evidence harness compares exact base
`4fe70d70762460d6656641bfa775121c4ffae058` with exact fixed tip
`e2e79332572261ec526475f40f2ebf08a7f17cdd`. Protocol v2 preserves the frozen
matrix, seed, three runs, 25 samples, ABBA ordering, thresholds, and safety gates.

Use clean, built source worktrees and keep all intermediate evidence outside Git:

```sh
export CAMPAIGN=/tmp/opencode/weaver-la6p/protocol-v2-pilot
export BASE=/home/sprawl/projects/weaver/worktrees/pr152-b-write-validation
export TIP=/home/sprawl/projects/weaver/worktrees/bound-schema-registration
export OLD=/home/sprawl/projects/weaver/worktrees/pr152-b2-schema-composition

node benchmarks/composition-validator/runner.mjs --phase self-test
timeout 1800 node benchmarks/composition-validator/runner.mjs --phase preflight \
  --base "$BASE" --tip "$TIP" --core auto --directory "$CAMPAIGN"
node benchmarks/composition-validator/runner.mjs --phase focused \
  --base "$BASE" --tip "$TIP" --old "$OLD" --core auto --directory "$CAMPAIGN"
timeout 1800 node benchmarks/composition-validator/runner.mjs --phase diagnostic \
  --base "$BASE" --tip "$TIP" --core auto --directory "$CAMPAIGN"
timeout 3600 node benchmarks/composition-validator/runner.mjs --phase pilot \
  --base "$BASE" --tip "$TIP" --core auto --directory "$CAMPAIGN"
```

The preflight is untimed and must compute the exact legacy-v1 hashes plus
independent v2 component hashes. Each measured child performs a correctness
probe, at least 20 fixed 100-operation warmup batches for at least ten seconds,
final 225–240 ms calibration (or an explicit 100-operation minimum condition),
three post-calibration batches, and exactly 25 samples. Every sample records its
batch duration. Auto affinity chooses the least-busy eligible physical core from
an exact two-second `/proc/stat` sample and excludes CPU0's physical core when an
alternative exists.

Diagnostic GC/heap/context-switch/frequency traces and all pilot data stay under
`/tmp`. A qualification miss is `INVESTIGATE`; do not start full shards. On GO,
run shards `0..15` sequentially with `--phase shard --set N --shard S`, then
`--phase merge-set --set N`. Discard an unstable set in full, cool for five
minutes, and use at most sets 0–2. Only a complete stable PASS may regenerate
`results/raw.json` and `REPORT.md`; canonical artifacts omit timestamps and trace
paths so repeated merge/report operations are byte-identical.
