---
"@weaver-conf/config-types": minor
"@weaver-conf/config-engine": minor
"@weaver-conf/config-registry": minor
---

Harden the bounded path, identity/service, snapshot, and registered-read schema domains against inherited numeric accessors. Captures inspect own descriptors, preserve ordered tuples and shared data, and return detached frozen values without invoking capabilities.

Breaking concrete-schema API change during pre-1 development: these schemas now use domain-backed Zod transform adapters rather than exposing object/tuple/preprocess container internals. Domain input/output types, brands, callable signatures and wire fields are retained. Keep using `parse`/`safeParse`; replace `.in`/`.out`/`.shape`/`unwrap` container traversal or `.extend`/`.pick` composition with the exported domain captures/predicates and explicit application schemas. Ordinary failures remain Zod errors with payload-safe domain diagnostics. Snapshot hazards continue to throw typed Weaver errors before field access. Unrelated object schemas, including `scopeInstanceSchema`, retain their concrete APIs.
