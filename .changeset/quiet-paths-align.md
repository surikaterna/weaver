---
"@weaver-conf/config-types": patch
"@weaver-conf/transport-scomp": patch
"@weaver-conf/weaver-client": patch
"@weaver-conf/weaver-server": patch
---

Align REST, SCOMP, and client schema-registration transports with path-first registered write and effective validation contracts, validate registered HTTP responses through the common timeout and typed error pipeline, compose caller cancellation with per-attempt timeouts, and retry only safe read requests when the server provides no mutation deduplication.
