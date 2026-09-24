# Composition validator benchmark report

## Verdict: FAIL

The frozen matrix stopped at the required safety boundary and was not silently reduced. Case `patch:shared:20` crashed during child setup or measurement: patch:shared:20/tip exited 1. A process crash/OOM is an immediate FAIL under the predeclared thresholds. Full 3 × 25 timing evidence, ordinary geomean, scaling, server ratio, and comparative memory summaries are therefore unavailable; stable full-matrix run count is **0**.

## Evidence

- Base: `4fe70d70762460d6656641bfa775121c4ffae058` (tree `6e4bae87cb18f314580dc2f15802926d80b0bd59`, packages `311d2073aae0e764ccd69b00d21f34f51b5c8cc1`, clean: true)
- Tip: `e2e79332572261ec526475f40f2ebf08a7f17cdd` (tree `92db6672620a61efc8e57b6c129ff292605ef928`, packages `670fe3413a87666349492e417b7266016d8fddf3`, clean: true)
- Seed: `0xD6615EED`; stopped case: `patch:shared:20`; completed measured samples: 5100
- Fixture manifest SHA-256: `34416e2f5b0b14e3202bb901f2461b92acf289944577e1ceaaa188084357d485`
- Raw JSON SHA-256: `239603edc06586f292f3a6945e3452973c4cc85f14d3c89aceaee1773a9227ff`
- Host: AMD Ryzen 7 9800X3D 8-Core Processor; x64; kernel 7.1.9-arch1-2; Node v24.21.0; V8 13.6.233.17-node.53
- Selected core: 0; affinity: pid 3708793's current affinity list: 0-15; topology: 0,8; cache: 98304K
- Governor/frequency/boost: performance / 5235488 kHz / 1
- Load: 1.62 / 1.78 / 1.70; RAM: 60.5 GiB; NODE_OPTIONS: --max-old-space-size=1024

## Build and stop details

Both exact worktrees completed frozen-lockfile installation and forced config-engine/server Turbo builds before execution. Recorded milliseconds: base install 211, engine 3263, server 6469; tip install 213, engine 3269, server 6408. Import, registration, fixture setup, calibration, warmup, hashing, and reporting are excluded from hot timing. The failure occurred in excluded setup, while registering the depth-40 shared-identity allOf schema through public `createSchemaRegistry` after constructing the service with public `createWeaverConfigService` and the in-memory provider. V8 reported ineffective mark-compacts near its approximately 4 GiB heap limit and terminated the child with JavaScript heap out of memory. This also exceeds the 1 GiB RSS safety ceiling by construction.

## Limitations

No ordinary geomean, worst paired cases, normalized scaling, server ratio, or matrix memory maximum is claimed from an incomplete run. Isolated smoke timings are intentionally excluded because they are not the frozen three-run stable matrix. CPU thermal, virtualization/container, turbo, and AC fields are retained in raw evidence where the host exposes them.
