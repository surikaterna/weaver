---
"@weaver-conf/weaver-client": major
---

Server-mode writes now return the server's decision rather than preflight against cached schemas. Generic HTTP writes dispatch once, do not queue or optimistically commit, and distinguish proven unsent requests from uncertain outcomes after dispatch. Local-only transports remain explicitly non-server-authoritative.
