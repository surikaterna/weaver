---
"@weaver-conf/config-types": major
"@weaver-conf/config-engine": major
"@weaver-conf/weaver-server": major
"@weaver-conf/weaver-client": major
"@weaver-conf/transport-scomp": major
---

Introduce path-first, object-root-only schema registration contracts, canonical service/fragment path derivation and slash-path/storage-key conversion, aligned identifier and slot-path schemas, prototype-pollution-safe path invariants, protected-by-default public reads for Weaver internal registry metadata, schema-compatible partial/effective validation APIs, and mandatory service-environment schema enforcement with canonical, non-overlapping batch identities at the core public write boundary used by direct, batch, REST, SCOMP, and client writes. Remove speculative schema policy hooks and operation-context plumbing while retaining REST authorization and schema audit metadata.
