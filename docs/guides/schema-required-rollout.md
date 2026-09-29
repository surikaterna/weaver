# Schema-required write rollout (weaver-yiam.4)

This is a breaking server admission change. Ship the complete, verified policy
stack together: `.5` fixtures and `.6` persistent binding are preparatory only;
`.1` makes direct service, REST and SCOMP writes schema-required, `.2` hardens
batch preflight, `.3` makes client/server outcomes authoritative, and `.4` is
the migration gate. Do not deploy an intermediate slice or turn admission off.
No stored application data is automatically deleted or inferred into schemas.

## Before making the new server public

1. Stop **all** old writers (including jobs, seeds and other server processes),
   drain in-flight requests, take a restorable, access-controlled snapshot of
   every provider/layer **and** its registry metadata. Record the old and new
   binary versions and the authoritative environment. Test restoring the backup
   to a separate instance. Coordinate other processes: service serialization
   and batch preflight do not provide cross-process transactions or rollback of
   writes already committed by a provider.
2. Inventory persisted values by environment, layer and scope (platform,
   tenant, scoped tenant/user and any other configured layer); inspect nested
   object keys, array members, fragments, overlapping parents and effective
   values after layering. Include unknown legacy roots and children. Compare
   each candidate to its *actual* registered service/fragment path. Registering
   a root does not grandfather its old children. For every intended writable
   child provide a structural schema witness at every segment: `properties`,
   matching `patternProperties`, or schema-valued `additionalProperties`.
   `additionalProperties: true` or omitted permits JSON Schema validation of
   an extra value but **does not authorize writes/removes** to that key.
   `additionalProperties: false` also makes an old extra child invalidate the
   full candidate; even writing a declared sibling may then fail validation.
3. Use a stopped-writer staging copy to check proposed registrations and
   *complete* replacement candidates against the same server build, across
   each affected layer/scope/environment. Register the service schema and any
   fragment slots, then fragment schemas, **before** initial application seed
   writes. Recheck full parent and fragment constraints, not just the target
   leaf. A registration does not rewrite existing values. If an old invalid
   value prevents a full candidate from validating, do **not** promise it can
   be fixed via `set`/`setMany`, a partial patch or a client preflight.
4. Only after validated data and registrations are prepared, start the new
   binary against the authoritative persistent provider. It must load and
   validate `_weaver.registry.schemas`, bind that one registry to the service,
   and only then expose HTTP/`readyz`. A proven fresh empty registry may bind
   and accept registrations, but public data writes fail until registration.
   If the provider cannot be read or registry bytes are corrupt, startup must
   fail closed: do not interpret errors as an empty registry, serve traffic,
   or wipe storage. Check readiness, perform one authorized read and a
   declared write, then restart a **new service** on the same provider and
   repeat; verify all legacy data and registration identities survived.
   Do not swap the bound registry on a running service or trust a caller-supplied
   registry for admission.

## Schema examples and expected denials

For service `billing` in environment `production`, an object with
`properties: { mode: { type: "string" }, items: { type: "array", items:
{ type: "string" } } }` allows validated `billing.mode` and a whole
`billing.items` array. An old `billing.rogue` remains readable under ordinary
read authorization, but `set` and `remove` return `SCHEMA_NOT_REGISTERED` with
no provider/revision/delta effects. A closed object (`additionalProperties:
false`) can reject even `billing.mode` when `rogue` persists; an open/default
object may allow that declared sibling while still denying `rogue`. Both
branches require explicit remediation rather than silent deletion.

For deliberate dynamic keys, `patternProperties: { "^flag_": { type:
"boolean" } }` can govern `flag_active`, while `additionalProperties:
{ type: "object", properties: { value: { type: "integer" } },
additionalProperties: false }` can govern arbitrary names but **not** an
undeclared nested `extra`. Register a fragment at an explicitly declared slot
before writing it; both its schema and overlapping parent constraints apply.
Check `allOf` constraints and the *winning* `anyOf`/`oneOf` branches; a
nonwinning branch or `not` does not grant write authority. Inspect tuple and
array-item constraints on whole-array candidates. Generic indexed paths such
as `billing.items[0]` are `UNSUPPORTED_OPERATION` even when `items` is
declared: write a validated whole array/object instead; existing arrays stay
intact on reads. Do not treat a numeric object member as an array index.

## Offline recovery and rollback

There is **no public repair API** and no global maintenance bypass. For an
invalid persisted candidate or orphaned legacy key, keep public writers
stopped; obtain an operator-approved, audited change record and an immutable
backup; prepare the smallest corrected **provider-native** snapshot in an
isolated copy (including relevant layered/effective values). Validate the
snapshot and registrations with the same version's schemas and staging server;
exercise reads and declared writes on that copy, then apply the reviewed
provider-specific restoration procedure **offline**, verify a fresh startup
and compare data to the backup. If the provider has no safe atomic restoration
procedure or validation fails, stop and escalate to the Architect/operator;
do not use an unimplemented repair endpoint, private `_weaver` writes through
public APIs, or an old binary as a migration tool. Internal protected access
is limited to canonical registry and existing pinned/scope recovery needs.

The registry key is exactly `_weaver.registry.schemas` on the authoritative
platform provider. Historical custom-key registry data must be backed up and
migrated **offline**, with ownership/environment/identity/slot checks and
validated canonical persistence before restart; the new server rejects a
custom persistence key and will not move or erase the old value. Legacy private
registry format (unversioned, plain schemas) may be read; newer binaries persist
the v2 registry envelope with version-1 encoded schema graphs. Preserve both
registry metadata and app data in backups. Stop old writers before the new
binary publishes the v2 envelope. Do not assume an
old binary can decode new registrations. Rolling back to an old binary also
reopens schemaless writes and may overwrite or lose registrations made since
the backup; coordinate a write freeze and restore only from a verified
compatible snapshot, or remain on the new binary. No automatic wipe.

For clients, `client.validate` is advisory, never admission. Cached reads can
work offline. An explicit local-only fixture/demo write is **not** a server
commit. For trusted server writes, `WRITE_UNAVAILABLE` means proven no send;
`WRITE_OUTCOME_UNKNOWN` means dispatch/receipt is ambiguous, possibly already
committed. Do not automatically retry, queue, replay or declare success for
unknown outcomes; reconcile via an authorized read and operator policy first.
The server remains the only write admission authority.
