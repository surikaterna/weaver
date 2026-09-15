---
"@weaver-conf/config-types": minor
"@weaver-conf/config-engine": minor
"@weaver-conf/weaver-server": major
"@weaver-conf/weaver-client": minor
"@weaver-conf/transport-scomp": minor
"@weaver-conf/storage-providers": patch
---

Use one schema-validated, coordinated mutation pipeline for application and
protected configuration. Require explicit initialized canonical control state,
strict application coverage, and current revision preconditions for schema
replacement. Persist individual canonical registration records and revisioned
full-context scope inventory instead of independent registry aggregates or
per-scope marker authority. Provide isolated code-validated bootstrap/control
views and run-bound full-object repair without public validation bypasses.

Registration clients can supply `ifRevision`; SCOMP schema administration requires
a trusted admin context supplied by its host. Schema compatibility diagnostics
are conservative and separate from all-context activation validation.

Server initialization and mutation policy changes are breaking. The leaf contracts,
raw-layer validators and optional client preconditions are additive; existing
client APIs remain supported. Mongo change ingestion now triggers validated reload
when an external document is malformed instead of silently ignoring that change.
