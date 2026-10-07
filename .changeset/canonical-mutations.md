---
"@weaver-conf/config-types": minor
"@weaver-conf/config-registry": minor
"@weaver-conf/config-service": minor
"@weaver-conf/weaver-server": minor
---

Add native contracts for ordered configuration mutation commands with explicit
selectors, detached JSON values, per-command storage receipts, and rejected,
partial, or unknown outcomes.

Replace native root and identity-port `set`/`remove` and their write DTOs with
`controller.forMutations(capability).apply(commands)`. Migrate single writes to
one-command lists with explicit identity, namespace, layer and path. The shared
FIFO validates every ordered prefix before effects, flushes each touched binding
once, and publishes a known final/prefix generation. Uncertainty reconciles a whole
observation without replay, remains fenced, and exposes no accepted revisions.
Existing shared-authority HTTP PUT/DELETE responses now contain canonical receipts
and commanded-identity revisions. Provider storage APIs and the legacy SDK protocol
are distinct and unchanged.

Share canonical declaration and policy evidence for explicitly permissive JSON
descendants, preserving inherited restrictions. Move value-patch preparation to
the service admission boundary and use canonical evidence for container inference;
ambiguous missing containers are rejected rather than guessed. Preserve explicit
null in dedicated patch admission.

Authorize public aggregate queries with shared canonical branch evidence, retaining
projection redaction and per-path host checks. Add the synchronous identity-port
`validate(anchorPath)` query over the current raw engine snapshot, with subtree
read authorization and sanitized native validation diagnostics.
