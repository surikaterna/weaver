---
"@weaver-conf/config-registry": minor
"@weaver-conf/config-service": minor
"@weaver-conf/config-types": minor
"@weaver-conf/weaver-server": patch
---

Own one live canonical registry per configuration root with explicit schema
capabilities, metadata queries, and same-queue persistence-before-publication.

Breaking: replace callable `host.registry` injection with detached persisted
`initial` data and a memory/provider storage selection. Migrate hosts to
`controller.forSchemas(token)` and explicit `schemaPermissions`, namespace and
environment grants. Authorization callbacks must handle schema-read/schema-register
variants. Uncertain schema persistence fences all payload access until recreation.

Move the existing v1/v2 registry and graph codecs into the browser-safe
`@weaver-conf/config-registry/persistence` export. Invalid public persistence data
now raises sanitized `VALIDATION_ERROR`, not raw parser exceptions. Server bootstrap
passes raw data to the owning root; the server's public options are unchanged.
