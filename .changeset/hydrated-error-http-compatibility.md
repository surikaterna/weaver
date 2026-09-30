---
"@weaver-conf/weaver-server": patch
---

Restore exhaustive generic HTTP status mapping for the shared hydrated error codes: DISPOSED maps to 410 and WRITE_ERROR to 500. Preserve all existing mappings and the legacy REST write-code allowlist and fallback behavior; no facade routes or runtime authority are introduced.
