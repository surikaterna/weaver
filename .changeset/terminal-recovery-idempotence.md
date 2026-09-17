---
"@weaver-conf/weaver-server": patch
---

Keep repeated terminal upgrade recovery idempotent: restore validated
application-only admission, and preserve restart-required admission closure for
built-in or infrastructure transitions.
