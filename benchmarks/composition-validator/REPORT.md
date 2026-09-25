# Composition validator final benchmark report

## Verdict: FAIL

- canonical matrix disturbed: one-minute load breached 8; server:anyOf-invalid/tip run-median spread 1.3011411157506596; ordinary:server:invalid/tip run-median spread 1.4433317362360572; oneOf:32:last/tip run-median spread 1.497471384001772; mixed:32:valid/tip run-median spread 1.2754156688420835; server:allOf-invalid/tip run-median spread 1.293309844986264; ordinary:partial:object-100-valid/tip run-median spread 1.2663782715590433; server:anyOf-valid/tip run-median spread 1.2391850583348796; ordinary:partial:string-valid/tip run-median spread 1.8772909699634501
- ordinary geomean 1.3437973195076498 > 1.10
- ordinary:partial:string-valid p50 ratio 2.372160906870862 > 1.15
- ordinary:partial:string-valid p95 ratio 2.9555402113900118 > 1.20
- ordinary:partial:object-100-invalid p50 ratio 1.4769110444885585 > 1.15
- ordinary:partial:object-100-invalid p95 ratio 1.5069183725932729 > 1.20
- ordinary:partial:string-invalid p50 ratio 1.4646715152197718 > 1.15
- ordinary:partial:string-invalid p95 ratio 1.4568810472020315 > 1.20
- ordinary:partial:object-100-valid p50 ratio 1.6294801635315022 > 1.15
- ordinary:partial:object-100-valid p95 ratio 1.749560599143917 > 1.20
- ordinary:effective:object-100-invalid p50 ratio 1.4192889042170058 > 1.15
- ordinary:effective:object-100-invalid p95 ratio 1.37038230278067 > 1.20
- ordinary:effective:string-invalid p50 ratio 1.6999587211374458 > 1.15
- ordinary:effective:string-invalid p95 ratio 2.430839119285747 > 1.20
- ordinary:patch:invalid p50 ratio 1.4073951443744173 > 1.15
- ordinary:patch:invalid p95 ratio 1.3731042533628572 > 1.20
- ordinary:patch:valid p50 ratio 1.3196425490431631 > 1.15
- ordinary:patch:valid p95 ratio 1.2675408217922344 > 1.20
- ordinary:effective:object-100-valid p50 ratio 1.457626073316113 > 1.15
- ordinary:effective:object-100-valid p95 ratio 1.4305019137413557 > 1.20
- ordinary:effective:string-valid p50 ratio 1.4467766133333546 > 1.15
- ordinary:effective:string-valid p95 ratio 1.3339158351539868 > 1.20
- server:anyOf-invalid ratio 2.3834802109464124 > 2.0
- server:oneOf-ambiguity ratio 2.357099413690075 > 2.0

## Reproducibility evidence

- Base: `4fe70d70762460d6656641bfa775121c4ffae058` (tree `6e4bae87cb18f314580dc2f15802926d80b0bd59`, packages `311d2073aae0e764ccd69b00d21f34f51b5c8cc1`, lock `9851bf580c5e8bdefa5f0e475219308fe20f8b3fd8d49dcd41d6b00bb5f29e8e`, clean: true)
- Tip: `e2e79332572261ec526475f40f2ebf08a7f17cdd` (tree `92db6672620a61efc8e57b6c129ff292605ef928`, packages `670fe3413a87666349492e417b7266016d8fddf3`, lock `9851bf580c5e8bdefa5f0e475219308fe20f8b3fd8d49dcd41d6b00bb5f29e8e`, clean: true)
- Seed/core: `0xD6615EED` / CPU 1; child affinity is recorded per run
- Host: AMD Ryzen 7 9800X3D 8-Core Processor; linux/x64; kernel 7.1.9-arch1-2; Node v24.21.0; V8 13.6.233.17-node.53
- Preflight: 126 descriptors / 154 records; hash `b1572d46ccc2970bb04783d1db16d1105b92e2dd5bdeb3229588524ca9c93630`; passed: true
- Timed matrix: 67 descriptors / 83 source cases / 249 child runs / 6225 samples
- Build durations: baseInstall=210ms, tipInstall=210ms, baseBuild=6470ms, tipBuild=6590ms
- Fixture manifest SHA-256: `8a2ab94b3c5624fc461e64e247cad5d0f6cd8556633ca7895aa03b6195f27f36`
- Raw JSON SHA-256: `c0bdfd264aca5591d113c28f4a2cb8fae4ad6b6d4af07e9dcf7b60948e72c0fb`

## Method and attempts

One child per source case/run, all sequential on fixed non-CPU0 CPU 1. Every complete child records 25 samples after bounded calibration and at least 5 final-shape batches / 2000 ms warmup. Setup, correctness, calibration, warmup, hashing, and report generation are untimed. No individual run was retried or trimmed.

- Attempt 0: disturbed; 249 child runs; load 1.38/2.25/2.35 -> 2.43/2.31/2.76; server:anyOf-invalid/tip run-median spread 1.2074019808489698; anyOf:2:none/tip run-median spread 1.8268096606686668; ordinary:effective:string-invalid/tip run-median spread 1.8369466161697199; anyOf:32:first/tip run-median spread 1.4707118431918684; oneOf:2:multiple/tip run-median spread 2.018605354570304; server:oneOf-ambiguity/tip run-median spread 1.2670100389266559; server:allOf-invalid/tip run-median spread 1.4048560301800357; server:anyOf-valid/tip run-median spread 1.2002472618142268
- Attempt 1: disturbed; 249 child runs; load 2.43/2.31/2.76 -> 9.16/6.22/4.20; one-minute load breached 8; server:anyOf-invalid/tip run-median spread 1.3011411157506596; ordinary:server:invalid/tip run-median spread 1.4433317362360572; oneOf:32:last/tip run-median spread 1.497471384001772; mixed:32:valid/tip run-median spread 1.2754156688420835; server:allOf-invalid/tip run-median spread 1.293309844986264; ordinary:partial:object-100-valid/tip run-median spread 1.2663782715590433; server:anyOf-valid/tip run-median spread 1.2391850583348796; ordinary:partial:string-valid/tip run-median spread 1.8772909699634501

## Ordinary base/tip gates

P50 geomean: **1.344x** (FAIL, limit 1.10). Worst p50: **ordinary:partial:string-valid 2.372x**. Worst p95: **ordinary:partial:string-valid 2.956x**. Times are ns/op.

| case | base p50 | tip p50 | p50 ratio | p50 gate | p95 ratio | p95 gate |
| --- | --- | --- | --- | --- | --- | --- |
| ordinary:partial:string-valid | 204.536 | 485.192 | 2.372 | FAIL | 2.956 | FAIL |
| ordinary:partial:object-100-invalid | 30568.969 | 45147.647 | 1.477 | FAIL | 1.507 | FAIL |
| ordinary:partial:array-1000-invalid | 104086.518 | 114408.042 | 1.099 | PASS | 1.112 | PASS |
| ordinary:partial:string-invalid | 308.798 | 452.287 | 1.465 | FAIL | 1.457 | FAIL |
| ordinary:effective:array-1000-invalid | 111891.316 | 125413.242 | 1.121 | PASS | 1.190 | PASS |
| ordinary:partial:object-100-valid | 30388.858 | 49518.042 | 1.629 | FAIL | 1.750 | FAIL |
| ordinary:effective:object-100-invalid | 31239.206 | 44337.459 | 1.419 | FAIL | 1.370 | FAIL |
| ordinary:effective:string-invalid | 318.623 | 541.645 | 1.700 | FAIL | 2.431 | FAIL |
| ordinary:effective:array-1000-valid | 112285.237 | 122476.029 | 1.091 | PASS | 1.035 | PASS |
| ordinary:patch:invalid | 1132.003 | 1593.175 | 1.407 | FAIL | 1.373 | FAIL |
| ordinary:patch:valid | 961.451 | 1268.771 | 1.320 | FAIL | 1.268 | FAIL |
| ordinary:effective:object-100-valid | 30412.241 | 44329.676 | 1.458 | FAIL | 1.431 | FAIL |
| ordinary:partial:array-1000-valid | 114655.056 | 118830.147 | 1.036 | PASS | 1.042 | PASS |
| ordinary:server:valid | 23069.311 | 24650.409 | 1.069 | PASS | 1.157 | PASS |
| ordinary:server:invalid | 11610.378 | 11163.729 | 0.962 | PASS | 0.920 | PASS |
| ordinary:effective:string-valid | 215.104 | 311.207 | 1.447 | FAIL | 1.334 | FAIL |

## Normalized scaling gates

Normalized growth is elapsed growth divided by work-unit growth. Worst: **oneOf-multiple 32->128 1.035x** (limit 1.50).

| family | range | small p50 | large p50 | normalized | gate |
| --- | --- | --- | --- | --- | --- |
| anyOf-first | 2->32 | 1354.349 | 14774.903 | 0.682 | PASS |
| anyOf-first | 32->128 | 14774.903 | 57019.003 | 0.965 | PASS |
| anyOf-first | 2->128 | 1354.349 | 57019.003 | 0.658 | PASS |
| anyOf-last | 2->32 | 1338.029 | 13991.711 | 0.654 | PASS |
| anyOf-last | 32->128 | 13991.711 | 53244.174 | 0.951 | PASS |
| anyOf-last | 2->128 | 1338.029 | 53244.174 | 0.622 | PASS |
| anyOf-none | 2->32 | 1709.844 | 16614.696 | 0.607 | PASS |
| anyOf-none | 32->128 | 16614.696 | 63863.115 | 0.961 | PASS |
| anyOf-none | 2->128 | 1709.844 | 63863.115 | 0.584 | PASS |
| anyOf-multiple | 2->32 | 1215.324 | 13707.980 | 0.705 | PASS |
| anyOf-multiple | 32->128 | 13707.980 | 53633.997 | 0.978 | PASS |
| anyOf-multiple | 2->128 | 1215.324 | 53633.997 | 0.690 | PASS |
| oneOf-first | 2->32 | 1396.739 | 14639.373 | 0.655 | PASS |
| oneOf-first | 32->128 | 14639.373 | 54430.026 | 0.930 | PASS |
| oneOf-first | 2->128 | 1396.739 | 54430.026 | 0.609 | PASS |
| oneOf-last | 2->32 | 1423.110 | 16621.204 | 0.730 | PASS |
| oneOf-last | 32->128 | 16621.204 | 55397.480 | 0.833 | PASS |
| oneOf-last | 2->128 | 1423.110 | 55397.480 | 0.608 | PASS |
| oneOf-none | 2->32 | 1580.628 | 16098.383 | 0.637 | PASS |
| oneOf-none | 32->128 | 16098.383 | 64046.850 | 0.995 | PASS |
| oneOf-none | 2->128 | 1580.628 | 64046.850 | 0.633 | PASS |
| oneOf-multiple | 2->32 | 1277.864 | 13997.776 | 0.685 | PASS |
| oneOf-multiple | 32->128 | 13997.776 | 57967.028 | 1.035 | PASS |
| oneOf-multiple | 2->128 | 1277.864 | 57967.028 | 0.709 | PASS |
| allOf-distinct-all-match | 2->32 | 1190.466 | 12453.246 | 0.654 | PASS |
| allOf-distinct-all-match | 32->128 | 12453.246 | 50006.312 | 1.004 | PASS |
| allOf-distinct-all-match | 2->128 | 1190.466 | 50006.312 | 0.656 | PASS |
| allOf-distinct-last-failure | 2->32 | 1460.032 | 12851.484 | 0.550 | PASS |
| allOf-distinct-last-failure | 32->128 | 12851.484 | 48649.171 | 0.946 | PASS |
| allOf-distinct-last-failure | 2->128 | 1460.032 | 48649.171 | 0.521 | PASS |

## Server full-candidate gates

Worst gated two-branch ratio: **server:anyOf-invalid 2.383x** (limit 2.0). not/shared-40 are safety-characterized only.

| case | p50 | ordinary p50 | ratio | gate |
| --- | --- | --- | --- | --- |
| server:anyOf-invalid | 26608.527 | 11163.729 | 2.383 | FAIL |
| server:shared-40 | 137163.088 | 11163.729 | 12.286 | characterized |
| server:allOf-valid | 31468.254 | 24650.409 | 1.277 | PASS |
| server:oneOf-ambiguity | 26314.019 | 11163.729 | 2.357 | FAIL |
| server:not-rejection | 23702.617 | 11163.729 | 2.123 | characterized |
| server:allOf-invalid | 16986.387 | 11163.729 | 1.522 | PASS |
| server:anyOf-valid | 35160.409 | 24650.409 | 1.426 | PASS |

## Variability and memory context

CV and drift are informational. Maximum CV: **53.21%**; maximum absolute first-five/last-five drift: **223.72%**; maximum observed RSS: **339.2 MiB** (hard limit 1024 MiB).

| case | source | run p95 ns/op | run CV % | run drift % | max RSS |
| --- | --- | --- | --- | --- | --- |
| anyOf:32:last | tip | 14244.110, 15952.500, 14249.168 | 2.93, 5.53, 2.38 | -3.61, -2.09, -2.05 | 109.3 MiB |
| ordinary:partial:string-valid | base | 205.332, 214.769, 230.003 | 1.23, 2.25, 4.34 | 0.98, 0.84, -3.06 | 89.1 MiB |
| oneOf:128:last | tip | 61538.021, 61706.854, 57967.091 | 5.09, 4.41, 2.89 | -0.26, 1.80, -2.24 | 138.3 MiB |
| patch:allOf:128 | tip | 103195.260, 100081.578, 107747.625 | 3.11, 1.99, 6.02 | -3.24, 0.83, -0.44 | 109.5 MiB |
| allOf:distinct:32:all-match | tip | 16241.679, 13336.826, 13055.854 | 7.73, 2.79, 2.35 | -1.28, -1.80, -1.51 | 108.6 MiB |
| allOf:distinct:2:all-match | tip | 1258.962, 1243.420, 1309.067 | 3.26, 2.70, 4.60 | -1.06, -4.57, -5.56 | 105.5 MiB |
| ordinary:partial:object-100-invalid | base | 31827.017, 34685.752, 32960.534 | 3.30, 4.93, 4.42 | -2.47, -4.11, -2.61 | 107.4 MiB |
| allOf:distinct:128:last-failure | tip | 50376.348, 59202.061, 49443.862 | 2.52, 7.84, 2.36 | 2.82, -2.95, -2.54 | 107.9 MiB |
| anyOf:2:last | tip | 1453.727, 1451.831, 1392.274 | 2.65, 5.17, 2.45 | -1.81, -7.10, -0.66 | 108.7 MiB |
| server:anyOf-invalid | tip | 35371.311, 34290.188, 32238.294 | 13.85, 11.25, 17.22 | 2.64, 5.12, 11.90 | 339.2 MiB |
| ordinary:patch:valid | tip | 1452.180, 1300.287, 1280.462 | 5.45, 1.48, 1.49 | 0.87, 1.57, -0.86 | 107.7 MiB |
| ordinary:partial:array-1000-invalid | base | 111516.237, 120818.911, 108598.817 | 2.80, 7.05, 2.21 | -4.77, -6.38, -2.91 | 108.4 MiB |
| anyOf:128:multiple | tip | 56362.855, 56300.943, 63810.460 | 3.41, 3.22, 7.19 | -2.86, -2.22, 2.13 | 139.6 MiB |
| patch:deferral:not | tip | 2722.047, 2800.232, 3244.270 | 1.88, 2.13, 5.67 | -3.60, -4.36, -0.07 | 93.8 MiB |
| anyOf:128:last | tip | 61979.447, 60158.158, 59184.055 | 7.52, 5.71, 5.20 | 3.44, 1.61, 8.31 | 137.6 MiB |
| anyOf:2:multiple | tip | 1346.077, 1306.042, 1245.326 | 5.06, 3.23, 1.61 | -2.72, -0.12, -3.51 | 106.7 MiB |
| ordinary:partial:object-100-invalid | tip | 52127.751, 49668.834, 46803.229 | 5.67, 3.69, 4.45 | -11.26, 0.24, 1.01 | 107.4 MiB |
| oneOf:128:first | tip | 55470.274, 56538.708, 58100.128 | 2.85, 3.85, 3.99 | -2.59, 0.40, -4.70 | 140.2 MiB |
| oneOf:2:multiple | tip | 1296.327, 1322.170, 1409.979 | 1.41, 2.84, 4.20 | 0.42, -1.18, -2.45 | 92.0 MiB |
| server:shared-40 | tip | 163529.866, 203895.891, 159956.960 | 9.31, 18.28, 8.36 | -0.78, 1.93, 4.81 | 276.2 MiB |
| ordinary:effective:string-valid | tip | 359.198, 338.236, 325.691 | 6.29, 2.88, 5.78 | -0.24, -0.52, -2.21 | 90.1 MiB |
| oneOf:32:none | tip | 17581.217, 18048.073, 17238.104 | 4.26, 6.45, 4.76 | -0.11, -9.57, -3.59 | 107.6 MiB |
| server:allOf-valid | tip | 33429.705, 32495.709, 33853.714 | 8.53, 8.31, 9.12 | 17.84, 6.43, 17.72 | 338.8 MiB |
| ordinary:partial:string-invalid | base | 349.876, 300.020, 355.763 | 5.60, 2.50, 5.62 | -2.70, -3.82, 1.09 | 89.2 MiB |
| ordinary:partial:array-1000-invalid | tip | 124008.789, 118083.376, 126815.651 | 3.27, 3.84, 4.71 | -1.86, -0.76, 10.07 | 202.1 MiB |
| oneOf:2:none | tip | 1679.005, 1720.913, 1689.579 | 3.38, 4.03, 4.03 | -2.27, 0.68, -1.55 | 106.3 MiB |
| ordinary:effective:array-1000-invalid | base | 112712.244, 122378.859, 131817.207 | 3.23, 5.14, 5.63 | 1.52, -7.38, 9.01 | 138.3 MiB |
| allOf:distinct:128:all-match | tip | 54628.063, 63662.244, 57996.396 | 5.25, 7.55, 7.55 | -0.49, 1.39, 2.51 | 137.8 MiB |
| ordinary:server:invalid | tip | 12328.706, 13005.191, 13170.188 | 22.38, 10.84, 12.15 | 7.51, 14.42, 23.45 | 334.7 MiB |
| anyOf:32:multiple | tip | 14391.549, 14589.119, 14305.861 | 2.87, 3.23, 4.96 | 0.91, 0.74, -2.88 | 107.4 MiB |
| linear:5000:invalid | tip | 3213602.235, 3263640.625, 3299848.839 | 2.73, 2.51, 2.54 | 3.09, 1.83, -2.92 | 319.1 MiB |
| ordinary:effective:object-100-valid | tip | 43641.887, 47933.711, 47851.689 | 1.01, 2.68, 3.23 | 1.49, 1.10, 2.60 | 108.4 MiB |
| server:oneOf-ambiguity | tip | 28386.460, 29263.512, 30738.178 | 7.05, 8.31, 8.02 | 8.12, -4.41, 9.76 | 333.1 MiB |
| ordinary:partial:object-100-valid | base | 33725.161, 33184.726, 31916.496 | 4.24, 4.56, 3.86 | -2.66, -8.46, -0.02 | 108.6 MiB |
| anyOf:2:first | tip | 1434.478, 1447.936, 1457.809 | 2.42, 4.15, 3.27 | -0.59, 1.71, 1.80 | 106.0 MiB |
| ordinary:effective:object-100-invalid | tip | 48719.500, 46978.778, 47459.850 | 4.49, 2.49, 2.70 | -7.28, -1.23, -0.01 | 108.0 MiB |
| oneOf:32:multiple | tip | 14863.880, 15072.190, 14719.247 | 3.80, 3.22, 2.16 | -3.32, -3.84, 1.35 | 110.0 MiB |
| ordinary:effective:object-100-invalid | base | 34632.562, 36168.891, 30245.603 | 4.34, 5.22, 1.72 | -3.08, 3.19, -1.76 | 108.0 MiB |
| patch:deferral:anyOf | tip | 2896.206, 2811.440, 2993.140 | 3.04, 2.52, 5.33 | -1.67, -2.52, 5.24 | 94.8 MiB |
| ordinary:effective:string-invalid | base | 336.815, 351.267, 372.915 | 3.80, 7.02, 5.25 | -4.81, -6.57, 0.15 | 88.9 MiB |
| oneOf:128:none | tip | 72017.935, 72969.121, 76346.510 | 6.07, 5.37, 8.94 | 2.16, 0.20, -3.82 | 137.5 MiB |
| oneOf:2:first | tip | 1475.065, 1385.730, 1483.015 | 2.94, 2.18, 3.24 | -3.54, -0.68, -2.20 | 108.3 MiB |
| ordinary:effective:array-1000-valid | base | 128964.462, 192272.655, 121637.747 | 6.23, 20.26, 5.13 | -0.63, -0.38, -1.92 | 108.3 MiB |
| ordinary:effective:array-1000-invalid | tip | 145613.650, 147224.526, 132172.666 | 6.42, 7.25, 4.31 | -5.16, -2.00, -3.34 | 204.2 MiB |
| ordinary:partial:array-1000-valid | tip | 132977.189, 130823.640, 126826.033 | 4.33, 3.80, 3.40 | -3.18, 1.96, 2.13 | 203.2 MiB |
| server:not-rejection | tip | 25255.887, 25560.970, 25986.908 | 7.49, 6.27, 9.91 | 8.98, -1.12, 5.47 | 337.1 MiB |
| patch:shared:40 | tip | 19963.381, 18534.055, 19756.330 | 5.63, 3.15, 4.10 | -2.82, -3.30, -3.86 | 107.6 MiB |
| ordinary:patch:invalid | base | 1311.302, 1287.976, 1182.940 | 6.76, 5.08, 3.83 | -0.17, -7.91, -4.47 | 91.1 MiB |
| ordinary:patch:valid | base | 1044.936, 1025.834, 999.216 | 3.44, 3.20, 2.08 | -6.69, 0.33, -2.28 | 92.2 MiB |
| linear:5000:valid | tip | 3255971.395, 3216928.077, 3081929.979 | 2.43, 4.86, 2.45 | -2.68, 2.41, -0.11 | 273.8 MiB |
| patch:deferral:oneOf | tip | 3042.091, 2968.146, 2834.624 | 3.88, 4.20, 2.20 | -2.30, -3.43, 2.22 | 94.1 MiB |
| allOf:shared:40 | tip | 24016.876, 24371.845, 22627.322 | 5.86, 6.14, 3.14 | 2.99, 8.15, 4.72 | 107.7 MiB |
| anyOf:2:none | tip | 1867.095, 1888.989, 1784.438 | 5.00, 5.94, 5.38 | 8.72, 1.33, -8.09 | 105.4 MiB |
| mixed:32:invalid | tip | 43065.418, 40709.789, 42610.180 | 4.47, 5.23, 4.51 | -2.74, 3.48, -7.96 | 138.1 MiB |
| ordinary:effective:object-100-valid | base | 31254.387, 33687.172, 33450.979 | 2.42, 3.64, 4.00 | 1.20, -2.25, -1.41 | 105.5 MiB |
| oneOf:128:multiple | tip | 67646.329, 59875.882, 62770.027 | 6.41, 3.54, 4.15 | 6.55, 0.24, -1.13 | 140.6 MiB |
| allOf:distinct:2:last-failure | tip | 1696.782, 1586.161, 1564.891 | 6.86, 3.66, 3.78 | -7.39, -3.61, -6.32 | 104.8 MiB |
| oneOf:2:last | tip | 1578.697, 1631.433, 1552.353 | 4.58, 5.90, 6.73 | -5.85, 3.31, -0.86 | 107.4 MiB |
| allOf:distinct:32:last-failure | tip | 13603.503, 14343.443, 14438.841 | 2.73, 5.68, 4.74 | -0.96, 0.54, -2.49 | 107.5 MiB |
| oneOf:32:first | tip | 16923.387, 16421.102, 15612.486 | 5.10, 5.04, 3.17 | 3.74, -1.77, 0.44 | 110.0 MiB |
| anyOf:128:none | tip | 66559.929, 71200.589, 72369.076 | 3.99, 5.79, 5.77 | -4.45, 3.85, 3.54 | 137.3 MiB |
| ordinary:partial:array-1000-valid | base | 124458.912, 126038.971, 125593.586 | 3.50, 4.28, 6.11 | 1.19, -1.77, -3.41 | 107.4 MiB |
| anyOf:128:first | tip | 67984.134, 59358.719, 66959.727 | 5.35, 2.67, 7.45 | -0.63, 0.96, -0.43 | 138.9 MiB |
| ordinary:server:valid | base | 31779.999, 36538.158, 24991.533 | 17.91, 22.93, 12.51 | 42.32, 0.21, 9.37 | 333.2 MiB |
| patch:leaf:valid | tip | 1949.794, 1894.541, 1984.365 | 3.34, 3.65, 4.38 | -1.75, -7.81, 1.61 | 107.0 MiB |
| anyOf:32:first | tip | 17638.812, 15856.343, 16358.781 | 5.10, 7.81, 4.36 | 1.65, -0.43, 6.80 | 107.4 MiB |
| ordinary:server:valid | tip | 36019.431, 39621.758, 36767.424 | 19.79, 21.36, 18.86 | 19.05, 3.60, -1.22 | 336.2 MiB |
| ordinary:partial:string-invalid | tip | 509.728, 568.178, 484.405 | 4.64, 7.99, 4.56 | -5.30, -3.29, 3.50 | 106.4 MiB |
| ordinary:effective:array-1000-valid | tip | 130820.927, 133426.424, 143088.932 | 4.13, 7.27, 6.65 | -3.13, 2.91, 9.20 | 202.8 MiB |
| oneOf:32:last | tip | 17932.811, 33998.250, 20421.089 | 8.64, 26.73, 10.19 | 2.82, -32.22, -13.91 | 110.1 MiB |
| ordinary:effective:string-invalid | tip | 996.430, 853.874, 710.119 | 27.99, 20.33, 14.81 | -9.98, -9.41, 23.04 | 92.4 MiB |
| mixed:32:valid | tip | 55716.950, 69163.540, 46167.204 | 9.37, 11.43, 5.78 | -16.40, -11.21, -8.14 | 109.2 MiB |
| anyOf:32:none | tip | 18926.880, 17969.139, 17897.593 | 5.35, 5.10, 4.68 | -6.92, -3.49, 1.15 | 107.3 MiB |
| ordinary:server:invalid | base | 13304.902, 14259.693, 14130.064 | 11.01, 16.24, 16.75 | -0.48, 4.66, 1.81 | 329.9 MiB |
| ordinary:patch:invalid | tip | 1719.212, 1788.116, 1768.525 | 4.54, 5.40, 5.59 | 4.32, -0.58, 12.14 | 97.1 MiB |
| server:allOf-invalid | tip | 19229.868, 33424.620, 33439.511 | 13.04, 35.12, 37.38 | 15.00, 29.43, -7.87 | 330.0 MiB |
| not:mismatch | tip | 1069.684, 1103.652, 1123.695 | 4.59, 4.83, 5.51 | -2.79, 1.37, 7.25 | 92.0 MiB |
| ordinary:partial:object-100-valid | tip | 58058.689, 86941.950, 51117.874 | 6.90, 16.91, 3.19 | -3.71, 42.08, -6.33 | 108.2 MiB |
| patch:leaf:invalid | tip | 2417.271, 2427.392, 2263.716 | 5.10, 5.57, 3.61 | -1.75, -5.89, -2.38 | 98.9 MiB |
| server:anyOf-valid | tip | 44782.975, 43128.296, 36738.411 | 11.86, 10.37, 12.40 | 9.46, 8.81, 10.71 | 333.3 MiB |
| ordinary:effective:string-valid | base | 253.566, 274.731, 245.047 | 5.76, 8.16, 7.37 | -2.52, -14.90, -1.26 | 89.6 MiB |
| ordinary:partial:string-valid | tip | 581.374, 1291.456, 634.758 | 23.35, 53.21, 16.68 | -5.85, 223.72, -27.91 | 92.2 MiB |
| not:match | tip | 1224.125, 1198.982, 1050.945 | 12.70, 11.73, 4.08 | -15.87, 18.62, -2.79 | 91.5 MiB |

## Correctness and limitations

All preflight and child probes use built public exports and check declared validity/error shape, server write/notification/revision effects, prototypes, and input/schema fingerprints. Memory is observational RSS/heap sampling, not allocation measurement. CV/drift are disclosed above but do not alter the verdict.
