---
"@weaver-conf/storage-providers": patch
"@weaver-conf/weaver-server": patch
---

Keep nested MongoDB configuration rooted in authoritative documents, preserve
concurrent same-root mutations and delete/recreate races with non-reusable CAS
tokens and bounded optimistic retries, preserve optional MongoDB peer loading,
remove every observed legacy duplicate with generation-aware comparisons,
preserve concurrent value-only recreations with deep-value CAS, compare stored
aliases by parsed path identity, and reject mutations whose operation-start root
snapshot exceeds 256 candidates. Remove whole roots with an authority guard
deleted last for storage-provider and server consumers.
