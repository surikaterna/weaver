---
"@weaver-conf/weaver-server": patch
"@weaver-conf/weaver-client": patch
---

Require explicit admin authorization for schema registration, filter every REST
scoped snapshot, and reject malformed or unprovisioned transport scope requests.
Keep SSE snapshots and changes on the same canonical full scope without falling
back to base state. Ignore malformed client scoped deltas before state or sync
notifications. Dynamic scopes require a persisted provisioning marker; explicit
scoped providers remain supported. Delegated workload registration is not enabled.

Preserve explicitly empty scopes at standalone HTTP SSE ingress and return typed
client errors before opening a stream, retaining CORS and sanitizing unexpected
server failures.

Cancel pending SSE creation during shutdown or HTTP disconnect before it can
subscribe, warm configuration, or publish a stream after cleanup.
