---
"@weaver-conf/config-types": major
"@weaver-conf/weaver-server": major
---

Require registered structural declarations for public configuration mutations and expose `SCHEMA_NOT_REGISTERED` as a typed error. Existing schemaless writes must register schemas before they can succeed. Persistent schema registries now accept only the omitted or exact `_weaver.registry.schemas` key; operators using a custom key must back up, inventory and migrate its metadata offline to that protected key before upgrading. Custom keys are rejected without moving or deleting stored data.
