# Canonical validated configuration pipeline

PR152 / **weaver-hywh, weaver-9qje, weaver-fteq, weaver-4z58,
weaver-29r**, under **weaver-s62**. This integration supersedes the earlier
foundation descriptions of optional coverage and marker-based scope admission.
The separately owned catalog contracts (`weaver-lyg0`), bootstrap executable
(`weaver-qkmd`), and maintenance executor (`weaver-ekin`) retain their boundaries.

The standalone [seed runtime](guides/bootstrap-config-repo.md) now uses this pipeline for initialization, HTTP/SSE/SCOMP composition and scope lifecycle. The low-level control API described here also supports explicitly initialized embedded scenarios; it is not an alternate standalone bootstrap option.

## One authority and one mutation path

`createWeaverConfigService` owns one `ConfigServiceController`, mutation
coordinator, provider-owner set, and `ConfigPipeline`. Trusted code contracts
bind before application registration is read. The control layer defaults to
`platform`; an explicit `controlLayer` can select another owned static layer.
Application/scoped providers cannot override its `_weaver` root.

The only registry authority is
`/_weaver/catalog/registrations/<internalRegistrationId(record)>` in that layer.
Each record contains its version, kind, request and trusted audit metadata.
The registry's Maps, slot composition and indexes are derived from committed
records. Multiple registry handles on a service observe the same projection;
they do not hydrate independent writers or serialize an aggregate Map back to
storage. Returned schemas and metadata are detached. A second read/write binding
cannot replace the service's canonical registry.

The serialized full-context inventory at `/_weaver/scopeInventory` is the sole
admission authority. Its revision and digest join the service authority vector.
An optional startup inventory hint is checked against this persisted value;
it is not an alternative catalog. Legacy `_weaver.scope.*` markers, warmed
caches and Cartesian products do not authorize contexts.

Every ordinary set, remove, registered object/patch, registration and lifecycle
operation runs under the existing coordinator. A candidate combines the declared
code-compiled static/dynamic layout with all active inventory contexts, including
cold physical data. Unsupported layer resolvers refuse instead of dropping data.
Each raw layer must have schema coverage and may be sparse or contain legitimate
raw references. The resolved/defaulted candidate must satisfy full service,
ancestor and fragment-slot contracts before provider IO.

Mutation inputs are detached at API admission, including queued values, serialized
context, and registration requests. Registered-write resolver methods are captured
and returned anchors detached. The executor owns a frozen value snapshot before
its first await and uses that value for candidate construction, commit and
publication; it never rereads the original caller object after validation.

After a successful conditional provider acknowledgement, the controller installs
the committed state and registry projection. Publication receives the exact
prevalidated resolved values, rather than fetching a secret again after commit.
Scoped mutations publish only their affected full contexts. Listener exceptions
cannot reverse an acknowledged write. Subsequent reads still validate their own
resolved values: an independently changed secret is not permission to deliver
invalid configuration.

`setMany` preserves the existing ordered-prefix contract, not a multi-key
transaction: all paths and the combined sparse candidate are checked first,
then each committed prefix must pass the same effective pipeline. A later
provider rejection does not roll back earlier acknowledged items.

## Restricted control admission

`createControlService` provides views over that same service and owner set, not
a second persistence implementation. Executable capabilities are reference-bound,
family/path-specific, and expire at the transaction boundary. Unawaited accepted
IO is drained before releasing the coordinator; simultaneous writes through one
transaction capability are rejected. A public `{ internal: true }` option has
no authority. Permission never bypasses code-contract validation.

An async owner context detects attempts to enqueue another operation on the same
coordinator while its callback is running. Public reads/writes, nested control
transactions, batch and close reject with a typed `FORBIDDEN` error, without
interleaving work or poisoning subsequent independent calls. Control owners use
their provided nonqueued `read`/`write` operations. Each such operation checks
callback lifetime and current readiness; retaining a closure cannot read live
protected state after the callback ends or admission closes.

Explicit initialization proceeds through these APIs, checking every result:

1. `initialize(configuration)` creates only an absent draft with
   valid format/infrastructure, empty registrations, empty revision-zero inventory,
   and empty upgrade records. Standalone uses `initializing` plus a seed/input-bound intent. General replacement of existing control state is forbidden.
2. `registerSchema(request, context?)` writes individual code-validated records.
   Draft control admission permits schema setup before application data is ready;
   application reads and public mutations remain unavailable.
3. `initializeInventory(inventory, expectedRevision)` is limited to the empty
   draft. Full physical context coverage is validated before activation.
4. `activateGeneration(id, expectedRevision)` validates the complete candidate and atomically changes its active pointer/initialized state. Low-level embedded callers may finalize an unchanged pointer with `finalize`. `application()` opens application
   admission only after validation and refuses pending recovery journals.

An explicitly initialized empty application catalog is valid only without
application data; it still rejects uncovered reads/writes. Missing, malformed
or uninitialized contracts never become a ready empty application fallback.
Control admission can expose pinned recovery information when application
catalog preparation fails, but cannot serve ordinary application configuration.

## Conditional registration and scope lifecycle

Changed registration content requires the current service revision in
`SchemaRegistrationContext.expectedRevision`. HTTP and SCOMP clients use
`SchemaRegistrationOptions.ifRevision`; HTTP sends a quoted `If-Match` header,
and SCOMP separates the precondition from the stored request. Actor/subject
metadata and options have Zod contracts. Transport administration requires trusted
admin identity; owner/contact fields in the request do not authorize it.

Registration evaluates grammar, parent/slot structure, and every affected context
before committing a single record. Required/nested changes and enum/range
tightening cannot invalidate an existing cold tenant. A stale vector rejects
without record, data, inventory, revision or event changes. Compatibility is
advisory: `compatible | breaking | unknown`; `hasBreakingChanges` is conservative,
and an opaque schema version label never establishes activation safety.

`createScopeManager` accepts either a canonical full `scopePath` or the
single-dimension `scopeId`/`value` convenience pair. Real transitions increment
inventory revision once, after validation; idempotent no-ops do not. Retirement
retains physical data, denies subsequent admission, and requires active children
to retire first. `archive: true` is not a destructive deletion API.

Inspection follows the same active full-context inventory for static scoped
providers, dynamic base layers and cached overlays. A shared child remains visible
only while an active full context authorizes it. Retired data remains physically
retained but cannot appear in core, REST or SCOMP inspection values or effective
layer claims. Returned inspection objects are detached from live state.

REST lifecycle routes accept `scope=tenant:acme/region:eu` for a full context.
The terminal scope must match the route's dimension and submitted/path value;
contradictory route/query targets fail before mutation. Omitting `scope` retains
the single-dimension API. Administrative gating precedes parsing and IO. Typed
provider errors remain typed HTTP failures (`WRITE_ERROR` is 503, revision
conflict is 409, unsupported physical authority is 409).

The REST adapter's `scopeManager` dependency is explicit. Standalone qkmd/2q6b now supplies the same runtime-owned manager used by SCOMP, rather than constructing a second inventory or bootstrap path.

Ordinary provisioning activates only already prepared, inventoried scope stores.
It does not create/delete arbitrary physical stores or claim a cross-provider
transaction. Missing capability/provider, read-only control and rejected commits
leave inventory unchanged. Lost acknowledgement enters nonready recovery instead
of reporting a successful lifecycle transition or claiming rollback.

## Repair boundary and provider guarantees

The control view's `storePlan`, `recordJournal`, `readRecovery` and `repairStep`
support a narrow run-bound full-object repair primitive. Repair binds the current
service vector, persisted owner/intent, plan target/mutation, catalog/inventory/
generation, complete application-provider revisions and data digests, and exact
raw preimage. The target object and target catalog must fully validate through
the ordinary candidate evaluator. The old full object need not satisfy the schema
whose violation motivated repair; the explicit planned replacement and exact raw
preimage authorize this transition, not a global validation exemption.

The single-provider commit uses the persisted operation identity. This primitive
does **not** complete the journal, activate an incompatible target catalog, or
implement maintenance orchestration/legacy conversion. A pending intent remains
recovery-required. The maintenance executor owns final all-context activation.

Owned memory, filesystem/Git and replica-set Mongo retain the guarantees in
[provider authority](provider-authority.md). Generic legacy providers retain only
their documented volatile process-local IO semantics; they never supply implicit
schemas and are refused for durable authority, scope IO and fenced repair.
There is no promise of active-active writers or cross-process CAS for a provider
without the executable authority protocol.

## Acceptance evidence map

All paths below are under `packages/weaver-server/test` unless stated otherwise.
These are executable acceptance references, not a replacement issue tracker.

| Boundary | Evidence | Required invariant |
| --- | --- | --- |
| Code-first initialization and internal path permissions | `validated-pipeline.node.mjs` | Missing/forged catalog is nonready; invalid internal records and cross-family writes have no effects. |
| Capability lifetime and shared queue | `pipeline-acceptance.node.mjs` | Escaped writer refuses; unawaited accepted IO cannot escape the coordinator. |
| P1 input ownership | `pipeline-input-ownership.node.mjs` | Resolver-barrier mutations of ordinary/object/patch/batch values, control records and queued context cannot change validated persistence/publication. |
| P2/P4 reentry and read lifetime | `control-operation-lifetime.node.mjs` | Reentrant operations settle with typed rejection; later reads/close remain usable; escaped read/write closures reject, including after close. |
| P3 retired inspection | `retired-inspection.node.mjs` | Startup-retired and newly retired static/dynamic data stays private across core/REST/SCOMP; shared children follow full-context activity without data deletion. |
| Generic provider coverage | `pipeline-acceptance.node.mjs` | No inferred schema; set/batch/remove/registered patch and ingestion still fail closed. |
| Canonical registry concurrency/restart | `validated-pipeline.node.mjs`, `pipeline-acceptance.node.mjs`, `core/schema-registry.test.mjs` | Memory and real filesystem commits survive restart; duplicate owners refuse; stale handles cannot overwrite siblings. |
| Conditional all-context activation | `pipeline-acceptance.node.mjs`, `validated-pipeline.node.mjs` | Required/nested/enum/range and cold-only failures leave records, data, revisions and events unchanged. |
| Exact validated publication | `pipeline-acceptance.node.mjs`, `foundation-integration.node.mjs` | No second backend resolution after commit; existing default/scoped projections retain ordering. |
| Scope persistence failures and full-context lifecycle | `scope-lifecycle-rest.node.mjs`, `pipeline-acceptance.node.mjs` | Admin-before-effects, CAS, read-only/missing capability, rejected persistence, child-first retirement and restart agree with durable inventory. |
| Reload, corrupt IO and lost acknowledgements | `validated-pipeline.node.mjs`, `authority-audit.node.mjs`, `core-foundation.node.mjs` | Never publish/drop invalid layers or return a ready fallback; recovery is explicit. |
| Fenced repair | `repair-transition.node.mjs`, `validated-pipeline.node.mjs` | Wrong preimage/vector/digest/target has zero effects; valid repair acknowledges one provider while admission stays isolated. |
| Protected indirect reads and ingress cancellation | `schema-foundations/*.node.mjs`, existing `src/server-*` and `src/transport/*regressions*` suites | REST/SCOMP/SSE/inspect and mounts do not leak `_weaver`; malformed/unknown scopes do not warm or subscribe. |
| HTTP SDK preconditions and defaults | client `test/schema-foundations/*.node.mjs` | Headers do not mutate registration records; stale409 is not retried; invalid options fail before fetch. |

## Code-principles disposition

Production files changed by this integration remain at most 400 lines, with
functions under 50 lines and nesting at most three levels. Factories and route
assemblers were decomposed rather than suppressed. Named exports and existing
package dependency direction are retained. New tests use Node's test runner;
retained Vitest suites are the inherited runner exception, not a new framework.

The changed serialized registration/options/context/result and lifecycle contracts
have corresponding Zod schemas. Provider objects, logger/secret callbacks,
transaction closures, `AbortSignal`, compiled layer functions, and SDK handles are
executable interfaces, not serialized contracts. No new explicit `any` or unsafe
type assertion is introduced. Existing generic legacy SDK assertions remain in
their original files with their original semantics; registered HTTP responses
continue through Zod validation. This is not a new safety or size exception.
