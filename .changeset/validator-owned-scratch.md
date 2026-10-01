---
"@weaver-conf/config-engine": patch
---

Harden the canonical configuration validator with descriptor-first own-data admission, owned scratch entries and own-only schema/member reads. Preserve ordinary validation diagnostics and call-local schema stability while rejecting malformed accessor/exotic data without invoking input getters. Caller schema prototypes alone do not reject valid own schema fields; literal payload/configuration/options/path data retain their separate plain-data restrictions. Standard ambient numeric prototype accessors cannot intercept validation scratch or supply missing schema members. This is not a hostile-intrinsic or Proxy side-effect sandbox.
