---
"@weaver-conf/weaver-server": patch
---

Integrate schema default delivery with coordinated provider authority. Use the
service's configured full-context inventory for REST and SSE scope admission,
retaining fail-closed marker admission when no inventory is configured and
preserving cancellation before warming or subscription.
