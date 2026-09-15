---
"@weaver-conf/config-types": major
"@weaver-conf/config-engine": minor
"@weaver-conf/config-sessions": patch
"@weaver-conf/storage-providers": major
"@weaver-conf/weaver-server": major
---

Establish explicit provider authority, stable revision vectors and atomic configuration mutation for PR152 (weaver-le5y, weaver-dpd6, weaver-913w, weaver-54ud, weaver-69k).

Malformed write paths resolve typed validation failures before effects. Required provider corruption fails startup/reload closed rather than silently dropping a layer. Current-format authority uses revisioned envelopes, instance-bound writer handles, conditional commits and operation receipts. Local filesystem and local Git checkout authority acknowledge fsync-backed persistence; Mongo replica-set authority uses single-document fenced majority+j writes. Memory authority is explicitly volatile. Unsupported basic adapters cannot opt into durable service authority.

Serialize configuration reads, patch preparation, validation, provider commit, installation and publication through one coordinator. Add validated complete scope inventory snapshots and refuse unknown contexts in inventory-bound services. Stable no-op/restart revisions retain sequence-based ABA protection; Git replication failures retain pending scoped paths without reversing locally committed mutations.

Harden authority lifecycle after independent audit: revoke filesystem handles before destructive release, retain phase-aware Mongo ownership evidence with safe conditional cleanup, preflight every provider before initialization, and require complete unique indexes on Mongo adoption. Pin Git checkout mutation while using a production replication-only path. Close service admission before attempting all independent cleanup, hold ownership for mutable read-only inputs, enforce static/retired scope inventory, validate full provider acknowledgements at the core boundary, and contain Mongo cursor-close failures.

Mongo recovery now fences previous unowned tuples before settling uncertain acquisitions, preventing delayed writes from reclaiming released ownership. Quarantine follows retained ownership effects independently of the initiating error code, preserving recovery after a conflict with uncertain abort cleanup.
