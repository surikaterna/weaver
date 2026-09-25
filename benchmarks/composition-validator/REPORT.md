# Composition validator replacement benchmark report

## Verdict: FAIL

- canonical matrix disturbed: one-minute load breached 8; ordinary:server:invalid/tip run-median spread 1.5385915808344088; server:oneOf-ambiguity/tip run-median spread 1.2335617830524004; oneOf:128:none/tip run-median spread 1.2397829623545962; server:not-rejection/tip run-median spread 1.285494378267285; ordinary:server:valid/tip run-median spread 1.4541014345292032; ordinary:server:invalid/base run-median spread 1.4817556978675792; server:allOf-invalid/tip run-median spread 1.4879362697393526; not:mismatch/tip run-median spread 1.7287669308735725; server:anyOf-valid/tip run-median spread 1.2612647334881542; not:match/tip run-median spread 1.4567385303306741
- server:anyOf-invalid ratio 2.3085986964673517 >= 2.0

## Reproducibility evidence

- Base: `4fe70d70762460d6656641bfa775121c4ffae058` (tree `6e4bae87cb18f314580dc2f15802926d80b0bd59`, packages `311d2073aae0e764ccd69b00d21f34f51b5c8cc1`, lock `9851bf580c5e8bdefa5f0e475219308fe20f8b3fd8d49dcd41d6b00bb5f29e8e`, clean: true)
- Tip: `1e24621603d4e4f134c8816ec0b50ccb488c76b3` (tree `2c2ca078299202d0986d0b38a8d2c5a17e7ccb00`, packages `7cad731169f6d9bda8674badd19a00185f5279b1`, lock `9851bf580c5e8bdefa5f0e475219308fe20f8b3fd8d49dcd41d6b00bb5f29e8e`, clean: true)
- Seed/core: `0xD6615EED` / CPU 1; child affinity is recorded per run
- Host: AMD Ryzen 7 9800X3D 8-Core Processor; linux/x64; kernel 7.1.9-arch1-2; Node v24.21.0; V8 13.6.233.17-node.53
- Preflight: 126 descriptors / 154 records; hash `b1572d46ccc2970bb04783d1db16d1105b92e2dd5bdeb3229588524ca9c93630`; passed: true
- Timed matrix: 67 descriptors / 83 source cases / 249 child runs / 6225 samples
- Build durations: baseInstall=227ms, tipInstall=223ms, baseBuild=6936ms, tipBuild=7076ms
- Fixture manifest SHA-256: `8a2ab94b3c5624fc461e64e247cad5d0f6cd8556633ca7895aa03b6195f27f36`
- Raw JSON SHA-256: `9ff587c3369b00638ffba5a552fab88e0baeb6c9fd2ad8bd44cb757834cc5987`

## Method and attempts

One child per source case/run, all sequential on fixed non-CPU0 CPU 1. Every complete child records 25 samples after bounded calibration and at least 5 final-shape batches / 2000 ms warmup. Setup, correctness, calibration, warmup, hashing, and report generation are untimed. No individual run was retried or trimmed.

- Attempt 0: disturbed; 249 child runs; load 4.87/5.78/6.20 -> 3.36/4.31/5.45; allOf:distinct:2:last-failure/tip run-median spread 1.4841958846015666; ordinary:server:invalid/base run-median spread 1.6139882835993977; ordinary:partial:array-1000-invalid/base run-median spread 1.2010675609552084; ordinary:effective:object-100-valid/base run-median spread 1.5197928377589063; linear:5000:valid/tip run-median spread 1.5998434267941517; ordinary:partial:string-valid/base run-median spread 1.217029641145957
- Attempt 1: disturbed; 249 child runs; load 3.36/4.31/5.45 -> 8.58/6.46/5.67; one-minute load breached 8; ordinary:server:invalid/tip run-median spread 1.5385915808344088; server:oneOf-ambiguity/tip run-median spread 1.2335617830524004; oneOf:128:none/tip run-median spread 1.2397829623545962; server:not-rejection/tip run-median spread 1.285494378267285; ordinary:server:valid/tip run-median spread 1.4541014345292032; ordinary:server:invalid/base run-median spread 1.4817556978675792; server:allOf-invalid/tip run-median spread 1.4879362697393526; not:mismatch/tip run-median spread 1.7287669308735725; server:anyOf-valid/tip run-median spread 1.2612647334881542; not:match/tip run-median spread 1.4567385303306741

## Ordinary base/tip gates

P50 geomean: **0.436x** (PASS, limit 1.10). Worst p50: **ordinary:patch:invalid 0.817x**. Worst p95: **ordinary:patch:invalid 0.828x**. Times are ns/op.

| case | base p50 | tip p50 | p50 ratio | p50 gate | p95 ratio | p95 gate |
| --- | --- | --- | --- | --- | --- | --- |
| ordinary:partial:string-valid | 212.896 | 45.328 | 0.213 | PASS | 0.204 | PASS |
| ordinary:partial:object-100-invalid | 31921.579 | 9898.501 | 0.310 | PASS | 0.316 | PASS |
| ordinary:partial:array-1000-invalid | 117724.943 | 66701.687 | 0.567 | PASS | 0.548 | PASS |
| ordinary:partial:string-invalid | 342.113 | 106.039 | 0.310 | PASS | 0.312 | PASS |
| ordinary:effective:array-1000-invalid | 113110.576 | 67543.468 | 0.597 | PASS | 0.621 | PASS |
| ordinary:partial:object-100-valid | 31790.769 | 10355.400 | 0.326 | PASS | 0.324 | PASS |
| ordinary:effective:object-100-invalid | 31621.769 | 11494.990 | 0.364 | PASS | 0.377 | PASS |
| ordinary:effective:string-invalid | 319.648 | 103.021 | 0.322 | PASS | 0.335 | PASS |
| ordinary:effective:array-1000-valid | 123057.216 | 68107.419 | 0.553 | PASS | 0.554 | PASS |
| ordinary:patch:invalid | 1179.299 | 963.396 | 0.817 | PASS | 0.828 | PASS |
| ordinary:patch:valid | 969.265 | 767.002 | 0.791 | PASS | 0.731 | PASS |
| ordinary:effective:object-100-valid | 32955.074 | 10552.247 | 0.320 | PASS | 0.330 | PASS |
| ordinary:partial:array-1000-valid | 113583.518 | 63590.803 | 0.560 | PASS | 0.568 | PASS |
| ordinary:server:valid | 22537.458 | 14850.475 | 0.659 | PASS | 0.782 | PASS |
| ordinary:server:invalid | 14907.771 | 10773.086 | 0.723 | PASS | 0.760 | PASS |
| ordinary:effective:string-valid | 225.240 | 47.675 | 0.212 | PASS | 0.216 | PASS |

## Normalized scaling gates

Normalized growth is elapsed growth divided by work-unit growth. Worst: **oneOf-none 32->128 1.166x** (limit 1.50).

| family | range | small p50 | large p50 | normalized | gate |
| --- | --- | --- | --- | --- | --- |
| anyOf-first | 2->32 | 791.108 | 6835.515 | 0.540 | PASS |
| anyOf-first | 32->128 | 6835.515 | 24651.047 | 0.902 | PASS |
| anyOf-first | 2->128 | 791.108 | 24651.047 | 0.487 | PASS |
| anyOf-last | 2->32 | 749.550 | 6217.478 | 0.518 | PASS |
| anyOf-last | 32->128 | 6217.478 | 23431.347 | 0.942 | PASS |
| anyOf-last | 2->128 | 749.550 | 23431.347 | 0.488 | PASS |
| anyOf-none | 2->32 | 809.293 | 6500.779 | 0.502 | PASS |
| anyOf-none | 32->128 | 6500.779 | 24168.305 | 0.929 | PASS |
| anyOf-none | 2->128 | 809.293 | 24168.305 | 0.467 | PASS |
| anyOf-multiple | 2->32 | 537.426 | 6503.274 | 0.756 | PASS |
| anyOf-multiple | 32->128 | 6503.274 | 24691.556 | 0.949 | PASS |
| anyOf-multiple | 2->128 | 537.426 | 24691.556 | 0.718 | PASS |
| oneOf-first | 2->32 | 773.629 | 6435.751 | 0.520 | PASS |
| oneOf-first | 32->128 | 6435.751 | 24664.761 | 0.958 | PASS |
| oneOf-first | 2->128 | 773.629 | 24664.761 | 0.498 | PASS |
| oneOf-last | 2->32 | 759.435 | 6696.433 | 0.551 | PASS |
| oneOf-last | 32->128 | 6696.433 | 24737.930 | 0.924 | PASS |
| oneOf-last | 2->128 | 759.435 | 24737.930 | 0.509 | PASS |
| oneOf-none | 2->32 | 844.979 | 6429.143 | 0.476 | PASS |
| oneOf-none | 32->128 | 6429.143 | 29979.180 | 1.166 | PASS |
| oneOf-none | 2->128 | 844.979 | 29979.180 | 0.554 | PASS |
| oneOf-multiple | 2->32 | 665.184 | 6560.584 | 0.616 | PASS |
| oneOf-multiple | 32->128 | 6560.584 | 24594.007 | 0.937 | PASS |
| oneOf-multiple | 2->128 | 665.184 | 24594.007 | 0.578 | PASS |
| allOf-distinct-all-match | 2->32 | 711.309 | 6402.137 | 0.563 | PASS |
| allOf-distinct-all-match | 32->128 | 6402.137 | 25127.731 | 0.981 | PASS |
| allOf-distinct-all-match | 2->128 | 711.309 | 25127.731 | 0.552 | PASS |
| allOf-distinct-last-failure | 2->32 | 850.426 | 6505.993 | 0.478 | PASS |
| allOf-distinct-last-failure | 32->128 | 6505.993 | 25261.565 | 0.971 | PASS |
| allOf-distinct-last-failure | 2->128 | 850.426 | 25261.565 | 0.464 | PASS |

## Server full-candidate gates

Worst gated two-branch ratio: **server:anyOf-invalid 2.309x** (strict limit <2.0). not/shared-40 are safety-characterized only.

| case | p50 | ordinary p50 | ratio | gate |
| --- | --- | --- | --- | --- |
| server:anyOf-invalid | 24870.733 | 10773.086 | 2.309 | FAIL |
| server:shared-40 | 124829.139 | 10773.086 | 11.587 | characterized |
| server:allOf-valid | 26687.766 | 14850.475 | 1.797 | PASS |
| server:oneOf-ambiguity | 18173.950 | 10773.086 | 1.687 | PASS |
| server:not-rejection | 16489.562 | 10773.086 | 1.531 | characterized |
| server:allOf-invalid | 9044.478 | 10773.086 | 0.840 | PASS |
| server:anyOf-valid | 27411.579 | 14850.475 | 1.846 | PASS |

## Variability and memory context

CV and drift are informational. Maximum CV: **39.10%**; maximum absolute first-five/last-five drift: **90.46%**; maximum observed RSS: **341.1 MiB** (hard limit 1024 MiB).

| case | source | run p95 ns/op | run CV % | run drift % | max RSS |
| --- | --- | --- | --- | --- | --- |
| anyOf:32:last | tip | 6731.848, 6752.329, 7171.205 | 3.29, 4.25, 5.06 | 2.36, -3.04, -1.76 | 92.3 MiB |
| ordinary:partial:string-valid | base | 244.148, 229.956, 239.109 | 4.71, 3.03, 5.18 | 3.32, -1.26, -1.71 | 92.7 MiB |
| oneOf:128:last | tip | 26578.841, 27586.709, 26393.730 | 3.95, 5.21, 5.53 | -6.74, 11.82, 2.13 | 108.1 MiB |
| patch:allOf:128 | tip | 65024.332, 69967.674, 87335.812 | 8.93, 4.45, 15.56 | 2.30, -3.98, -5.67 | 140.3 MiB |
| allOf:distinct:32:all-match | tip | 7478.484, 6781.994, 6525.394 | 6.29, 3.08, 3.14 | 0.77, -3.71, -1.11 | 106.2 MiB |
| allOf:distinct:2:all-match | tip | 732.659, 760.600, 751.436 | 4.07, 3.61, 3.73 | -1.56, -1.40, 1.14 | 94.8 MiB |
| ordinary:partial:object-100-invalid | base | 32910.690, 34349.299, 35725.105 | 2.18, 6.77, 5.32 | -2.28, -2.61, 1.32 | 108.1 MiB |
| allOf:distinct:128:last-failure | tip | 27603.931, 27180.886, 28350.181 | 4.74, 3.76, 5.07 | 1.56, -3.14, 6.49 | 107.4 MiB |
| anyOf:2:last | tip | 809.505, 779.757, 878.167 | 5.22, 4.14, 6.32 | -5.06, 2.37, 3.47 | 95.0 MiB |
| server:anyOf-invalid | tip | 36343.343, 38105.769, 27334.631 | 21.62, 25.03, 8.54 | 6.37, -0.24, 9.07 | 337.0 MiB |
| ordinary:patch:valid | tip | 799.086, 797.877, 844.542 | 2.38, 1.89, 2.40 | -0.05, -3.37, 1.16 | 94.4 MiB |
| ordinary:partial:array-1000-invalid | base | 115955.185, 127604.868, 128150.263 | 2.83, 3.82, 3.63 | -2.89, -3.77, -0.42 | 108.0 MiB |
| anyOf:128:multiple | tip | 26881.155, 26299.670, 26492.335 | 4.14, 3.96, 3.10 | -1.23, 0.37, -0.54 | 106.3 MiB |
| patch:deferral:not | tip | 2456.724, 2443.079, 2543.332 | 5.44, 4.83, 5.36 | -6.93, -3.74, 4.91 | 109.1 MiB |
| anyOf:128:last | tip | 24418.522, 24965.707, 25416.069 | 2.19, 3.70, 3.53 | -1.51, 1.25, 1.62 | 107.9 MiB |
| anyOf:2:multiple | tip | 622.753, 563.611, 574.504 | 5.17, 4.55, 5.04 | -4.20, -0.73, 1.50 | 93.3 MiB |
| ordinary:partial:object-100-invalid | tip | 10852.387, 11123.318, 10612.303 | 5.59, 5.42, 4.11 | -5.68, -3.99, 4.39 | 106.2 MiB |
| oneOf:128:first | tip | 26171.775, 27854.586, 26386.437 | 3.86, 5.63, 3.40 | 4.53, 0.35, -4.31 | 108.8 MiB |
| oneOf:2:multiple | tip | 733.541, 696.134, 742.392 | 5.43, 3.24, 6.09 | 1.80, -3.47, 7.54 | 92.8 MiB |
| server:shared-40 | tip | 164647.434, 150771.643, 147779.702 | 10.45, 9.02, 9.01 | 9.77, 10.48, -3.58 | 285.1 MiB |
| ordinary:effective:string-valid | tip | 44.657, 53.484, 54.087 | 2.69, 4.26, 4.61 | -4.28, 5.07, 4.42 | 90.9 MiB |
| oneOf:32:none | tip | 6586.942, 7476.280, 7141.205 | 2.37, 5.79, 5.59 | 2.20, -7.28, -4.55 | 105.9 MiB |
| server:allOf-valid | tip | 48476.227, 46120.233, 41375.051 | 28.64, 28.31, 27.39 | 4.05, -6.80, 33.28 | 341.1 MiB |
| ordinary:partial:string-invalid | base | 351.905, 379.519, 400.991 | 4.58, 5.95, 6.45 | 3.16, -2.78, -6.94 | 91.0 MiB |
| ordinary:partial:array-1000-invalid | tip | 82478.664, 69961.019, 63181.633 | 7.95, 3.73, 3.25 | -9.37, -1.65, -2.29 | 136.8 MiB |
| oneOf:2:none | tip | 930.859, 1147.893, 951.387 | 6.27, 13.13, 4.87 | 0.64, -2.06, -2.89 | 93.3 MiB |
| ordinary:effective:array-1000-invalid | base | 120679.502, 121874.729, 125079.061 | 4.81, 4.79, 4.26 | -9.14, 0.74, -4.89 | 107.1 MiB |
| allOf:distinct:128:all-match | tip | 28379.242, 26780.114, 27885.673 | 5.66, 4.91, 4.94 | -1.50, -3.30, -6.27 | 106.8 MiB |
| ordinary:server:invalid | tip | 14750.367, 13050.195, 11446.656 | 12.39, 13.18, 22.29 | 27.78, 9.30, 21.43 | 331.3 MiB |
| anyOf:32:multiple | tip | 6876.583, 7490.895, 6578.312 | 4.20, 5.90, 3.42 | 0.57, 0.13, -2.17 | 107.5 MiB |
| linear:5000:invalid | tip | 2632660.621, 2819880.854, 2636425.085 | 3.27, 5.64, 4.68 | 2.72, -7.73, -1.56 | 220.9 MiB |
| ordinary:effective:object-100-valid | tip | 11796.335, 11457.589, 13336.971 | 6.17, 4.68, 10.73 | -5.40, -7.84, -9.12 | 106.7 MiB |
| server:oneOf-ambiguity | tip | 35682.862, 23580.277, 36313.778 | 31.15, 12.48, 33.82 | 17.74, -0.57, 32.31 | 337.1 MiB |
| ordinary:partial:object-100-valid | base | 33512.352, 34688.722, 35278.442 | 3.40, 4.38, 4.36 | 4.42, 1.24, 0.32 | 108.4 MiB |
| anyOf:2:first | tip | 891.060, 880.474, 844.935 | 3.98, 5.99, 7.88 | -1.62, 3.39, -1.82 | 92.3 MiB |
| ordinary:effective:object-100-invalid | tip | 13258.273, 12598.358, 12802.651 | 7.93, 6.10, 6.82 | -13.04, -2.05, -8.65 | 106.0 MiB |
| oneOf:32:multiple | tip | 6982.434, 7132.850, 9392.014 | 3.39, 4.87, 14.32 | -1.20, 4.64, -1.43 | 107.9 MiB |
| ordinary:effective:object-100-invalid | base | 32182.374, 33927.103, 36889.394 | 2.20, 4.46, 12.99 | -2.29, -6.51, 1.65 | 108.1 MiB |
| patch:deferral:anyOf | tip | 2485.738, 2668.189, 2674.134 | 4.51, 10.96, 5.46 | 1.26, -2.30, -8.02 | 94.6 MiB |
| ordinary:effective:string-invalid | base | 349.924, 342.735, 346.358 | 4.48, 3.52, 4.83 | 0.02, -0.26, 12.79 | 90.2 MiB |
| oneOf:128:none | tip | 26155.024, 56426.464, 51958.490 | 3.44, 34.21, 27.21 | 3.27, 90.46, -38.64 | 107.1 MiB |
| oneOf:2:first | tip | 962.992, 1325.653, 900.442 | 12.39, 20.80, 15.79 | -16.04, -1.00, -8.94 | 92.1 MiB |
| ordinary:effective:array-1000-valid | base | 132559.877, 141847.592, 136991.469 | 4.74, 7.15, 5.10 | 0.76, -0.03, 0.47 | 106.9 MiB |
| ordinary:effective:array-1000-invalid | tip | 75700.502, 75977.447, 75572.277 | 4.50, 6.35, 9.10 | -1.26, -11.21, -16.72 | 138.3 MiB |
| ordinary:partial:array-1000-valid | tip | 71096.546, 76423.371, 66457.757 | 6.22, 6.45, 3.62 | -5.88, -0.49, -2.49 | 139.4 MiB |
| server:not-rejection | tip | 32558.582, 31708.631, 22448.245 | 31.98, 39.10, 17.72 | -19.65, 33.66, -5.60 | 335.3 MiB |
| patch:shared:40 | tip | 21625.266, 20092.038, 21050.615 | 7.05, 4.80, 4.94 | -1.98, 3.75, -1.69 | 107.7 MiB |
| ordinary:patch:invalid | base | 1308.629, 1277.721, 1255.846 | 5.26, 3.64, 3.09 | -5.22, -2.07, -7.23 | 93.4 MiB |
| ordinary:patch:valid | base | 1343.717, 1046.875, 1093.156 | 10.30, 3.43, 5.08 | -5.41, -3.40, -1.48 | 93.4 MiB |
| linear:5000:valid | tip | 3138874.609, 2523427.522, 2332679.090 | 14.04, 3.93, 2.44 | 11.89, -6.41, -0.02 | 228.9 MiB |
| patch:deferral:oneOf | tip | 2668.162, 2580.240, 2790.039 | 5.22, 5.47, 5.55 | 2.17, 2.36, -1.95 | 95.9 MiB |
| allOf:shared:40 | tip | 22142.963, 22971.932, 23514.891 | 3.54, 4.70, 5.02 | 2.07, 1.19, 1.73 | 107.3 MiB |
| anyOf:2:none | tip | 886.386, 903.631, 861.306 | 4.35, 4.64, 4.67 | -7.30, -10.04, -6.75 | 93.3 MiB |
| mixed:32:invalid | tip | 33603.517, 33626.222, 34149.486 | 5.97, 5.85, 7.17 | 2.12, -5.81, 11.03 | 106.7 MiB |
| ordinary:effective:object-100-valid | base | 35774.025, 36595.514, 34352.564 | 4.18, 5.31, 3.23 | -4.57, 3.33, -3.38 | 107.2 MiB |
| oneOf:128:multiple | tip | 27063.640, 26146.838, 26375.346 | 4.99, 4.71, 3.99 | -1.10, -4.64, -1.43 | 93.2 MiB |
| allOf:distinct:2:last-failure | tip | 1015.994, 935.644, 855.425 | 5.03, 4.77, 3.16 | -6.97, -0.71, -2.33 | 94.5 MiB |
| oneOf:2:last | tip | 849.078, 840.968, 795.998 | 5.04, 4.35, 4.18 | -2.37, 7.30, -3.37 | 92.9 MiB |
| allOf:distinct:32:last-failure | tip | 7475.459, 6763.742, 7400.189 | 6.05, 3.30, 4.79 | -1.90, -1.90, -0.36 | 107.6 MiB |
| oneOf:32:first | tip | 7012.098, 7242.285, 7173.237 | 3.69, 5.39, 4.48 | 4.71, -3.12, -3.06 | 92.0 MiB |
| anyOf:128:none | tip | 27318.601, 25385.783, 25284.477 | 5.38, 3.55, 3.70 | 2.72, 5.02, 1.83 | 107.5 MiB |
| ordinary:partial:array-1000-valid | base | 125065.305, 126936.245, 118300.158 | 4.33, 5.64, 4.20 | -3.45, -1.93, -3.30 | 107.2 MiB |
| anyOf:128:first | tip | 27299.913, 27660.742, 25745.535 | 3.79, 3.91, 3.71 | -0.88, 3.77, -2.61 | 108.8 MiB |
| ordinary:server:valid | base | 25614.793, 26010.862, 27434.586 | 8.88, 7.66, 10.28 | -6.43, 6.84, -5.77 | 333.7 MiB |
| patch:leaf:valid | tip | 1872.954, 2009.658, 1937.528 | 4.32, 5.65, 6.15 | 0.31, 0.36, -2.26 | 96.3 MiB |
| anyOf:32:first | tip | 7007.447, 7465.336, 11696.448 | 4.76, 5.36, 24.12 | -8.00, -3.03, -7.38 | 91.5 MiB |
| ordinary:server:valid | tip | 20350.435, 19741.991, 22580.422 | 15.02, 16.16, 13.03 | -7.80, -4.69, 16.15 | 340.7 MiB |
| ordinary:partial:string-invalid | tip | 113.588, 118.383, 119.599 | 4.36, 5.45, 5.50 | -0.56, -0.21, -2.21 | 91.2 MiB |
| ordinary:effective:array-1000-valid | tip | 71948.160, 75909.123, 85185.238 | 4.97, 5.34, 8.81 | 6.35, -2.01, -10.64 | 140.6 MiB |
| oneOf:32:last | tip | 7132.208, 7337.498, 6499.881 | 4.41, 4.46, 3.29 | -0.73, 4.12, 0.66 | 104.8 MiB |
| ordinary:effective:string-invalid | tip | 116.172, 107.614, 120.370 | 7.17, 3.78, 6.11 | 9.76, -4.37, 11.02 | 90.2 MiB |
| mixed:32:valid | tip | 34058.279, 32656.492, 30811.727 | 7.58, 5.90, 4.88 | 4.32, 4.94, 1.34 | 107.1 MiB |
| anyOf:32:none | tip | 7182.006, 6977.955, 7940.826 | 4.81, 4.39, 7.45 | -2.54, 4.09, 7.94 | 104.4 MiB |
| ordinary:server:invalid | base | 16498.551, 17174.220, 24670.268 | 9.02, 17.97, 10.69 | 15.76, 11.70, 15.19 | 333.3 MiB |
| ordinary:patch:invalid | tip | 1073.823, 1002.832, 1058.246 | 4.88, 2.19, 4.61 | -2.01, -0.56, -4.07 | 92.0 MiB |
| server:allOf-invalid | tip | 12157.888, 12055.792, 15585.276 | 19.13, 17.31, 11.26 | 3.84, 16.28, 20.60 | 335.4 MiB |
| not:mismatch | tip | 1067.388, 1054.047, 603.832 | 20.26, 26.33, 5.14 | 74.09, -39.24, -7.26 | 92.3 MiB |
| ordinary:partial:object-100-valid | tip | 11254.948, 11921.658, 11182.038 | 4.66, 7.73, 5.46 | 3.69, -10.86, 7.09 | 106.9 MiB |
| patch:leaf:invalid | tip | 2023.535, 1920.714, 2221.790 | 5.54, 4.84, 8.41 | -3.23, 2.01, 5.60 | 95.1 MiB |
| server:anyOf-valid | tip | 41896.432, 46706.581, 43989.857 | 27.54, 23.41, 28.18 | 4.53, 14.08, 21.36 | 335.7 MiB |
| ordinary:effective:string-valid | base | 234.248, 248.131, 274.579 | 4.20, 6.32, 7.05 | -1.74, 6.21, 2.32 | 89.1 MiB |
| ordinary:partial:string-valid | tip | 48.766, 53.243, 47.523 | 4.90, 4.76, 2.52 | -0.35, 2.09, 0.00 | 90.2 MiB |
| not:match | tip | 707.484, 716.052, 1159.404 | 4.01, 5.77, 20.87 | -2.29, -6.76, 62.30 | 93.1 MiB |

## Correctness and limitations

All preflight and child probes use built public exports and check declared validity/error shape, server write/notification/revision effects, prototypes, and input/schema fingerprints. Memory is observational RSS/heap sampling, not allocation measurement. CV/drift are disclosed above but do not alter the verdict.
