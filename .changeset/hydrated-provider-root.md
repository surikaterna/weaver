---
"@weaver-conf/config-service": minor
"@weaver-conf/config-types": minor
---

Add a provider-backed, read-only hydrated root and explicit factory binding contracts.
The root awaits hydration, shares canonical registered public projection and engine
provenance, and owns only explicitly transferred resources. Writes, reload and flush
remain unavailable; scoped factories, sessions and governed authority are not included.
