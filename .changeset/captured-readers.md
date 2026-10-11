---
"@weaver-conf/config-types": minor
"@weaver-conf/config-service": minor
"@weaver-conf/config-registry": minor
"@weaver-conf/config-engine": minor
"@weaver-conf/weaver-server": minor
---

Replace unbound configuration-root reads and mutable root principal binding with
host-issued captured readers. The configuration root owns lifecycle operations
only. Configure explicit host authorization and obtain a reader with
`controller.forIdentity(capability, { identity, namespace })`.

Migrate absolute reader paths to relative literal segment arrays. Use
`get(segments, { layer, defaultValue })` instead of separate layer/default
methods, and `snapshot(segments)` for one coherent value/revision envelope.
`withScope` replaces the entire ordered scope tuple and returns an independent
handle. Root reads and `bindRoot` are removed without compatibility aliases.

Resolve named views through the canonical engine using base-then-view tiers and
source-aware provenance, preserving physical provider ranks. Named view mutations
use the same `forMutations(capability).apply(commands)` executor with an optional
`viewId`; removing the selected namespace resets only that view's explicit layer.
Base namespace replacement/removal preserves existing instance storage.

Reader projection checks current grants and host authorization for each requested
branch, including explicit sensitive/role access. Restricted arrays are redacted
as a whole rather than returned with holes or fabricated null elements.

Validation authorizes captured metadata independently of value validity and returns
sanitized canonical validator diagnostics for authorized invalid compositions.
The registry projection contract includes `authorizeValidation(path, access)` as a
payload-free policy check; it does not enable raw reads. Partial raw layers retain
their restrictive metadata without invalidating a valid resolved composition.

Suppress private queued deliveries whose previous or current snapshot uses an older
registry policy revision, including physical view policy changes. This prevents stale
aggregate projections from disclosing newly restricted children without discarding
ordinary data-only generations or substituting newer values into older events.

Keep inherited policy identities in structural read-context cache keys so shared
schema graphs cannot transfer an allowed sibling's privileges to a restricted
physical view source. Structural sharing remains enabled without global path keys.
