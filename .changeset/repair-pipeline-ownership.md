---
"@weaver-conf/weaver-server": patch
---

Detach and freeze mutation values and context before asynchronous work so validation,
provider commits and publication cannot observe different caller-owned values.
Reject reentrant calls to the same configuration coordinator instead of deadlocking.
Keep retired scope data out of public inspection and expire every control operation,
including reads, at the callback boundary or when service admission closes.
