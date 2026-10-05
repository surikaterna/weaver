---
"@weaver-conf/storage-providers": patch
---

Reject malformed or unreadable filesystem configuration instead of reporting
healthy empty entries. JSON/shape failures now reject with a sanitized
`VALIDATION_ERROR`; non-ENOENT read failures reject with `SERVER_DEGRADED`.
Missing files and optional missing overlays still resolve as empty inputs.
An invalid overlay rejects the entire load, and corrupt mutation targets are
preserved rather than overwritten. Callers that relied on malformed files
appearing empty must now catch failures or use their host's explicit degraded
hydration policy.

Watcher read failures retain the last good snapshot without emitting false
deletions. An active watcher can recover on the next valid filesystem event;
after an initial subscription read failure, repair the file and re-subscribe.
Pending watcher reads and unsubscribe callbacks are bound to their own
subscription, so replacing a subscription cannot leak native watchers or let
retired callbacks interfere with the replacement.
