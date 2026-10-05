---
"@weaver-conf/config-policy": minor
---

Add an explicit browser-safe `@weaver-conf/config-policy/browser` entry for policy evaluation, validation, ratchet rules, and in-memory override tracking. Browser consumers should import this subpath rather than the Node root; the root and its real filesystem tracker remain unchanged.
