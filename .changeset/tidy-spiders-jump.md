---
"@weaver-conf/storage-providers": patch
"@weaver-conf/weaver-server": patch
---

Keep nested MongoDB configuration rooted in authoritative documents, preserve
concurrent same-root mutations and delete/recreate races with non-reusable CAS
tokens and bounded optimistic retries, preserve optional MongoDB peer loading,
remove every observed legacy duplicate with generation-aware comparisons,
preserve concurrent recreations, compare stored aliases by parsed path identity,
and bound cleanup discovery payloads for storage-provider and server consumers.
