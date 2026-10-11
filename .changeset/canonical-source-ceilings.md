---
"@weaver-conf/config-engine": minor
"@weaver-conf/config-types": minor
"@weaver-conf/config-registry": minor
"@weaver-conf/config-service": minor
"@weaver-conf/config-auth": minor
"@weaver-conf/config-policy": minor
"@weaver-conf/weaver-server": minor
---

Add optional source-local ceilings to resolution layers. The canonical resolver
intersects them with global ceilings using physical configured ranks while
preserving input stack order, atomic replacement protection, and source origins.
All ceiling ranks are validated even for empty or trusted-emergency layers.
Omitting source ceilings preserves existing resolution behavior.

Enable registered configured-name ceilings across native service snapshots,
prospective writes, views, schema publication, reload and session lifecycle.
Raw layer observations remain distinct from ceiling-resolved effective values.
Preserve finite declared tuple ceilings in object/array unions even when all raw
candidates are objects, null, or missing; destructive higher-rank writes cannot
erase that policy. Ordinary read membership and wildcard expansion are unchanged.

Breaking: replace policy-toolkit access `sessionMode` and `overrideReason` with
host-verified `trustedSession: { id, emergency, reason }`; remove
`AuthConfig.elevatedSessionMode`. Native service callers must select an actual
root-owned session, never supply trusted eligibility in request data. Unknown
ceiling names fail before provider effects, including annotations under `not`.
Native negative assertions remain validation-only, not positive or inverse
ceiling policy. Configure ceiling names in the root layer order.

Fix native partial validation of `not`: negative predicates use complete effective
semantics and mode-partitioned memoization, avoiding false rejection when a required
member is absent. Ordinary partial omissions and ancestor patch deferral are unchanged.

Breaking: custom server auth gates must implement `gateSchemaWrite`. Factory
compositions must explicitly configure `schemaAdminRoles` and migrate any schema
restriction in `canWrite` to optional synchronous `canRegisterSchema`. The callback
only narrows configured roles; service-token administrative markers do not bypass
them. Schema reads retain `gateRead`. Default server authorization captures actual
bootstrapped provider slot ranks instead of a hardcoded profile; unknown targets
and ceilings fail closed. This does not migrate the legacy resolution engine.
