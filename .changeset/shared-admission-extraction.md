---
"@weaver-conf/weaver-server": patch
---

Delegate canonical configuration mutation admission to the shared
`@weaver-conf/config-service/admission` implementation. Legacy server batch,
dedicated mutation, validation and transport behavior are unchanged. This does
not enable the separately planned central authority hosting mode.
