---
"@weaver-conf/config-engine": patch
---

Remove the ambient Node type dependency from isNodeError declarations while preserving the structurally compatible Node error result. Reject malformed optional error fields to correct previously unsound narrowing; valid Node errors retain their original identity.
