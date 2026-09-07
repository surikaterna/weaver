---
"@weaver-conf/config-types": major
"@weaver-conf/config-engine": major
"@weaver-conf/weaver-server": major
"@weaver-conf/weaver-client": major
"@weaver-conf/transport-scomp": major
"@weaver-conf/config-policy": major
"@weaver-conf/config-runtime": patch
---

Introduce path-first, object-root-only schema registration contracts, canonical service/fragment path derivation and slash-path/storage-key conversion, aligned identifier and slot-path schemas, prototype-pollution-safe path invariants, protected-by-default public reads for Weaver internal registry metadata, schema-compatible partial/effective validation APIs, mandatory service-environment schema enforcement with canonical, non-overlapping batch identities at the core public write boundary, and fail-closed effective validation at the core runtime read boundary used by REST, SCOMP, SSE, and clients. Snapshots expose complete resolved effective base and scope states backed by isolated per-context mount maps and secret caches. Resolution recursively follows mounted objects and arrays, resolves nested mount and secret markers, uses canonical array-aware secret cache identities with cycle protection, and treats malformed mount candidates as unresolved without leaking markers or throwing raw parser errors. Serialized runtime feeds fan inherited changes into materialized scopes, invalidate an aggregate registered root when any overlapping schema is invalid, and recover it with one fully resolved root projection after mutations or schema registration without allowing listener failures to fail committed operations. Remove namespace-to-schema client adapters, owner-based schema composition exports, speculative schema policy hooks, and operation-context plumbing while retaining ordinary config namespacing, REST authorization, schema audit metadata, owner-neutral schema generation, and policy validation.
