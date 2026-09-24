# Composition validator benchmark report

## Verdict: FAIL

The frozen matrix stopped at the required safety boundary and was not silently reduced. Case `server:shared-40` crashed during schema-registration: V8 fatal JavaScript heap out of memory near 4 GiB after ineffective mark-compacts; child crashed before calibration. A process crash/OOM is an immediate FAIL under the predeclared thresholds. Full 3 × 25 timing evidence, ordinary geomean, scaling, server ratio, and comparative memory summaries are therefore unavailable; stable full-matrix run count is **0**.

## Evidence

- Base: `4fe70d70762460d6656641bfa775121c4ffae058` (tree `6e4bae87cb18f314580dc2f15802926d80b0bd59`, packages `311d2073aae0e764ccd69b00d21f34f51b5c8cc1`, clean: true)
- Tip: `45788214845d84a83aca54cbb5f5c99cb0fceed5` (tree `62759035cd9782a29c991f1da191fe50796fe00c`, packages `ee513496fc80465ab15ca492d4c790ee68f842e1`, clean: true)
- Seed: `0xD6615EED`; stopped case: `server:shared-40`; completed measured samples: 0
- Fixture manifest SHA-256: `34416e2f5b0b14e3202bb901f2461b92acf289944577e1ceaaa188084357d485`
- Raw JSON SHA-256: `08a3a2d1c55e375c2929fe60b8339cef2cd5011f6f8665b8b0f367d63440f3a7`
- Host: AMD Ryzen 7 9800X3D 8-Core Processor; x64; kernel 7.1.9-arch1-2; Node v24.21.0; V8 13.6.233.17-node.53
- Selected core: 0; affinity: pid 3348239's current affinity list: 0-15; topology: 0,8; cache: 98304K
- Governor/frequency/boost: performance / 5180217 kHz / 1
- Load: 0.69 / 1.32 / 1.09; RAM: 60.5 GiB; NODE_OPTIONS: unset

## Build and stop details

Both exact worktrees completed frozen-lockfile installation and forced config-engine/server Turbo builds before execution. Recorded milliseconds: base install 177, engine 3079, server 6685; tip install 181, engine 3068, server 6637. Import, registration, fixture setup, calibration, warmup, hashing, and reporting are excluded from hot timing. The failure occurred in excluded setup, while registering the depth-40 shared-identity allOf schema through public `createSchemaRegistry` after constructing the service with public `createWeaverConfigService` and the in-memory provider. V8 reported ineffective mark-compacts near its approximately 4 GiB heap limit and terminated the child with JavaScript heap out of memory. This also exceeds the 1 GiB RSS safety ceiling by construction.

## Limitations

No ordinary geomean, worst paired cases, normalized scaling, server ratio, or matrix memory maximum is claimed from an incomplete run. Isolated smoke timings are intentionally excluded because they are not the frozen three-run stable matrix. CPU thermal, virtualization/container, turbo, and AC fields are retained in raw evidence where the host exposes them.
