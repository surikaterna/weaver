---
"@weaver-conf/config-types": minor
"@weaver-conf/config-engine": minor
"@weaver-conf/weaver-server": minor
---

Define the code-pinned version-1 internal catalog, strict serialized infrastructure/registration/upgrade contracts, and independent engine-backed preparation and recovery APIs (weaver-lyg0, PR152/weaver-s62). Persisted documents cannot replace built-in validators. Pipeline activation and storage migration remain separate workstreams.

Reject recovery journals whose declared per-authority data-step order contradicts receipt lineage, while preserving interleaved providers and control bookkeeping.
