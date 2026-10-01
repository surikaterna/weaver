---
"@weaver-conf/weaver-server": patch
---

Admit raw registered schema descriptors at object-write, patch-write and effective-validation boundaries before semantic preparation or retrieval. Recheck current schemas after awaited reads, including absent returned values, and refresh the call-local patch session when the schema reference changes. Own accessor hazards reject with static typed schema errors without invoking getters; legitimate plain schema mutations and borrower identities are preserved. This keeps caller-data safety at the facade boundary while the pure engine remains a trusted-schema validator, not an executable-code sandbox.
