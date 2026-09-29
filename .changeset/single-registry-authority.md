---
"@weaver-conf/weaver-server": patch
---

Prevent multiple schema registries from binding to one config service and require verified persistence before exposing a hydrated registry. Generic writes retain their existing behavior until the schema-required cutover.
