---
"@weaver-conf/config-types": minor
"@weaver-conf/config-service": minor
---

Connect canonical core publication, provider reload, explicit declared-writer flush,
opt-in provider watch and revision-bounded host restart acknowledgement.

Breaking: replace ConfigurationEffectiveChange/configurationEffectiveChangeSchema
with ConfigurationReaderChange/configurationReaderChangeSchema. Subscribe with
reader.onChange(relativeSegments, listener, options?) and narrow kind to effective,
layer or invalidation. Selection and previousRevision are explicit; stale/schema
invalidations carry no values. Root restartState/acknowledgeRestart are host-only.
No transport feed, automatic replay, uncertainty recovery or process rollout is added.
