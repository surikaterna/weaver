---
"@weaver-conf/weaver-server": patch
---

Return revision-safe REST envelopes for pre-routing invalid request targets and JWT failures, so strict clients can map 400/401 errors without exposing protected state.
