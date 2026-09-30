# Hydrated service contracts (weaver-0b81.2)

This additive alpha contract slice exports types and runtime shape schemas from
`@weaver-conf/config-types`. It does **not** implement factories, providers,
authorization, hydration, events or disposal. Existing runtime reads and writes,
provider `WriteResult`, and legacy exports remain unchanged.

## Migration map

| Legacy API | Selected contract |
| --- | --- |
| `ConfigurationService`, generic or Zod-argument reads | `HydratedConfigurationService`, synchronous `unknown` reads without a value schema |
| `ConfigurationInspection<T>` | `HydratedConfigurationInspection`, explicit missing/value/redacted effective state and ordered contributions |
| Void writes or `Promise<void>` | Await `set`/`remove`, narrow `ConfigurationServiceWriteResult` by `success` |
| Scoped dotted keys and `.root` | `HydratedScopedConfigurationService`, readonly relative literal tuples, no root/client/transport/session/writer exposure |
| Service reads/restart callbacks | `HydratedServiceConfigurationService`, policy-gated namespace reads and explicit restart acknowledgement |
| Legacy `forView`/instance mutation | Deferred executable view capability, not a legacy signature revival |

Parse absolute paths with `canonicalConfigurationPathSchema`: non-root slash
paths with no empty/trailing, dot/dot-dot, bracket, prototype or `_weaver`
segments. Parse relative paths with `relativeConfigurationPathSchema`: nonempty
readonly literal segment tuples. Dots within a segment and Unicode are retained
exactly; there is no normalization, percent decoding or escaping alias. Later
adapters qualify paths **once** using the existing engine canonical/storage codec.
Client/provider legacy dot/bracket keys are not changed by these declarations.

Identity captures environment and the **complete ordered** scope path. Parsing
copies/freezes the identity, scope array and scope records, rejects duplicate
scope IDs, and preserves provider-local values (including colon/comma).
Transport wire restrictions still apply at the existing transport boundary.
`withScope` replaces the path, never appends ambient scope; selecting scope is
not authorization. Future hydration must preload identities before synchronous
reads: cold reads throw `WeaverErrorInstance` with `SCOPE_NOT_LOADED`, disposed
reads with `DISPOSED`, and only genuinely missing keys return `undefined`.

Inspection/event DTOs distinguish missing from redacted; redacted branches cannot
contain `value`. Value branches require a present non-undefined data property.
Contributions retain actual low-to-high precedence, with unique layer/provider
pairs. Shapes cannot establish genuine provenance, atomic runtime snapshots,
or authorization. Future implementations must detach/freeze payload snapshots
and omit sensitive payloads from both effective values and contributions.

Writes capture identity. Options contain only `layer` and optional `ifRevision`;
actor, roles, environment, scope and session overrides are rejected. Success
requires layer and revision, after awaited provider acceptance/required flush
and coherent publication—not universal fsync or transactional durability.
Rejected errors must not use `WRITE_OUTCOME_UNKNOWN`. Unknown outcomes must use
that code: storage may already have committed, so reconcile rather than promise
rollback. Canonical policy denial remains `POLICY_VIOLATION`. Missing write
authority returns `WRITE_UNAVAILABLE`; root ownership does not authenticate.

## Shape validation is not a security boundary

Every new DTO and executable interface has a co-located Zod schema. Inputs are
descriptor-checked before Zod reads fields: strict records reject unknown keys,
accessors (without executing getters), symbols, nonenumerable and reserved
prototype keys, nonplain prototypes and cyclic structures. Interface schemas
check callable/field shape only, **not** function arguments/results or capability
authenticity. They do not invoke methods and must never be used to mint a grant.

The future composite `@weaver-conf/config-service` wraps the same unified client
and governed embedded authority; `config-runtime` remains pure. There is no
second validator or registry. Factory options, borrowed/owned provider/session
bindings, authority adapters, writer grants and executable view interfaces are
deliberately not exported here. Trusted host principal/grant issuance remains
`weaver-0b81.10`; never trust plugin-supplied actor/role claims.

The selected view **data mapping**, not a grant, is literal
`<namespace>/instances/<viewId>`: same namespace/identity, instance-first then
base fallback. A granted reset would remove only that instance override in an
explicit layer. View selection authority and executable signatures are deferred.

Future root disposal is idempotent: fence writes, detach owned subscriptions,
clear owned ephemeral sessions, flush owned dirty providers and invoke every
explicit owned disposal hook even after failure, returning aggregated typed
errors. Never fabricate `provider.dispose`. Borrowed providers/sessions are not
closed, cleared or flushed merely by teardown; scoped handles dispose only their
listeners. These lifecycle requirements are documentation, not implemented
behavior in this slice.
