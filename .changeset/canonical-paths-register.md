---
"@weaver-conf/config-types": minor
"@weaver-conf/config-engine": minor
"@weaver-conf/weaver-server": major
"@weaver-conf/weaver-client": major
"@weaver-conf/transport-scomp": major
---

Introduce canonical JSON Schema service and fragment registration contracts, address registry entries by canonical paths, and preserve schema requests directly across transport and server boundaries. Remove namespace-derived registration and its Zod-to-JSON-Schema conversion so the canonical request and response are the only registration transport contracts.
