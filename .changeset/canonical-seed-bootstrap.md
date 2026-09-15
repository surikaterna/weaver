---
"@weaver-conf/config-types": major
"@weaver-conf/config-engine": minor
"@weaver-conf/config-runtime": major
"@weaver-conf/storage-providers": major
"@weaver-conf/weaver-server": major
---

Replace standalone repository/implicit-memory bootstrap with explicit seed-bound initialization, validated infrastructure generations and current-format authority (weaver-qkmd, weaver-mic8, weaver-2q6b).

Wire the real CLI and HTTP/SSE/SCOMP runtime to one owned config service, canonical registry and scope manager. Persist code-pinned initialization intent before store preparation; validate all contexts and activate conditionally, with exact-intent resume and restart-only infrastructure activation. Compile declared Layers/defineWeaver order through the shared scope-stack/merge pipeline; implement asynchronous built-in layer resolvers and refuse uninstalled semantics.

Remove obsolete bootstrap/registry codecs, options, exports, environment overlays and legacy FS/Mongo readers without deleting operator data. Preserve nested IO, ownership/receipt guarantees, conditional registered-anchor rollback, provenance and explicit embedded volatile capabilities. Update the built-in catalog pin/version, programmatic contracts, operator runbook and current-format/real lifecycle regressions.

Address bootstrap audit findings weaver-qfid, weaver-xfke and weaver-dzb8: restore unauthenticated CORS preflight while retaining actual mutation authentication/roles; prevalidate a deterministic dependency-ordered registration installation plan while preserving the exact original intent digest, resuming only identical requests and completed records; reject FIFO/private input hazards without blocking and bound bytes through actual EOF. Replace obsolete test-mode duplication with real filesystem registry/restart matrices and retain the verified weaver-2q6b wiring.
