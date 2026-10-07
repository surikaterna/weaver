# @weaver-conf/config-service

`createConfigurationService(options, host)` awaits a provider-backed lifecycle root.
All synchronous reads and inspection use one canonical registered authorized projection
of the same engine-issued identity snapshot. The root exposes neither provider,
registry, client nor transport handles. No consumer namespace, environment or role
is built into the implementation.

```ts
import { createConfigurationService } from "@weaver-conf/config-service";
import { canonicalConfigurationPathSchema, type ConfigurationReader } from "@weaver-conf/config-types";

let reader: ConfigurationReader | undefined;
const identity = { environment: "development", scopePath: [] };
const root = await createConfigurationService({
  identity,
  schemas: hostRegistrations, // ordered service, slot declarations, then fragments
  layers: [{ kind: "fixed", layer: "settings", providerIds: [provider.id] }],
  providers: [{
    id: provider.id, layer: "settings", provider,
    environment: { kind: "environments", environments: ["development"] },
    operation: { kind: "load" }, ownership: { kind: "borrowed" },
  }],
}, {
  authConfig: hostAuthConfig,
  hostAuthority: hostAuthorizer,
  onAuthorityReady(controller) {
    // The host verifies the principal and supplies explicit read grants.
    reader = controller.forIdentity(controller.mint(hostPrincipal), {
      identity, namespace: canonicalConfigurationPathSchema.parse("/example"),
    });
  },
});
if (!reader) throw new Error("Host reader was not initialized");
const value = reader.get(["enabled"]); // synchronous, no provider/network operation
const snapshot = reader.snapshot(["enabled"]); // atomic projected value and revision
const inspection = reader.inspect(["enabled"]);
reader.dispose(); // only this reader's subscriptions, never provider ownership
await root.dispose();
```

The host supplies actual `ConfigurationStorageProvider` capabilities. `load` calls
the captured provider method with its original receiver and **no arguments**;
`load-layer` calls the expressly selected dialect with one layer argument. A trusted
`read` callback receives frozen full identity plus the selected exact scope prefix.
Provider instances are not cloned or frozen. Callback schemas validate callable
shape, not trust, authorization or promise behavior.

Fixed bindings require an explicit environment set or host-approved `common` mapping.
Scope bindings require an explicit environment set and nonempty exact ordered prefix.
Each dynamic slot expands contributors in identity order at its configured position,
before subsequent fixed slots. Duplicate identifiers/selectors, unused/ambiguous
bindings and invalid canonical registrations fail before any provider read. Every
schema position carrying override-ceiling metadata and custom resolution options
is unsupported in this default-merge slice, even without corresponding data.

`reader.withScope(scopePath).prepare()` stages distinct identities FIFO and
deduplicates pending/ready tuples. `withScope` replaces the entire ordered tuple;
it returns a new independently disposable handle without I/O. Each waiting handle
retains its own authorization check, even when hydration work is shared.
Context-independent fixed contributions are retained on scope preload; accepted writes
and reloads update the retained vector used by future preloads. Explicit read adapters
hydrate per identity rather than sharing context-dependent data.
Publication is atomic; failure leaves all existing identity snapshots unchanged.
Readers capture their selection and expose its current revision. Cold scope reads throw
`SCOPE_NOT_LOADED` before path reads; defaults never hide unknown or forbidden paths.
Unknown schema paths reject, sensitive/reference descendants remain denied, and
public aggregates retain only declared public siblings. Missing declared data is
ordinary `undefined`. Composite object provenance may have no effective layer.

Default provider failure rejects `SERVER_DEGRADED` with sanitized provider IDs;
`allow-degraded` explicitly omits failed contributions and reports degraded mode.
Owned hooks transfer only after complete validity and are attempted once at terminal
dispose, including unselected owned bindings. Borrowed resources are never closed
implicitly flushed. Explicit writer bindings may require flushing borrowed providers.
Disposal fences immediately, waits queued work, invokes all owned
provider hooks despite individual failures, and memoizes its Result. Cleanup notes
contain IDs and static messages, never provider payloads. Failed preload does not
dispose live root-owned providers. Standard host intrinsics and trusted hooks are
assumed; own caller accessors/cycles/exotic snapshot data are rejected before reads.

The root directly owns readiness, identity revisions and registered projections.
There is no internal client cache, snapshot transport, SDK boot or staleness timer.
`weaver-client` remains the external transport-backed consumer SDK, not mandatory
host infrastructure. Reader subscriptions are idempotent; initialization/preload
produces no fictional effective-change event.

The approved architecture uses this application authority for embedded and future
central hosting. The current server is **not yet migrated**; its future adapter
retains authentication, transports and durable bootstrap. One authoritative API
writer per backing configuration domain is a deployment responsibility, not a
distributed lock or multiwriter guarantee. Explicit out-of-band provider inputs may
refresh through the authority publication path; this does not coordinate
concurrent API writers. There is no automatic hybrid mutation replay: pending is
not committed, required flush is not universal durability, and timeout after
dispatch is not rollback.

Without explicit writer opt-in, writes reject `WRITE_UNAVAILABLE`,
even for writable providers. Root reload and flush are host lifecycle operations;
after disposal these return `DISPOSED`. Ceiling integration, sessions and transport
feeds remain successor work, not alpha/product readiness claims. Production
imports no filesystem, storage aggregate or server package. Node hosts may inject
the public filesystem provider and explicitly map its construction-time environment
overlay and `loadLayer` file dialect.

The unpublished source seed is `0.0.0`, `private:false`, public access, with a minor
changeset. No version application or publication is authorized by this package.

## Trusted host authority

`createConfigurationService(options, host)` requires a service-owned
`ConfigurationServiceHostOptions` argument with explicit authorization and a
synchronous `onAuthorityReady` callback. The root exposes only health and lifecycle;
there is no one-argument public-read mode or root read shortcut.
`configurationServiceHostBindingSchema` supplies the same host configuration shape
without the callback for server composition, not a second factory or authority.
principal, grant, request, decision, audit and writer-binding DTOs and their native
Zod schemas are exported by `@weaver-conf/config-types`.

The host is trusted composition code, not consumer configuration or proof of an
external identity. An authority binding requires explicit `authConfig` and both
`hostAuthority.authorizeReadSync` and `hostAuthority.authorizeWrite`. Decisions
are the strings `"allowed"` or `"denied"`. Callbacks can narrow grants, never
override structural denial, internal visibility or reference-source taint. Sensitive
values require an explicit sensitive grant; role visibility additionally uses the
host's actual `withAuth` mappings. No default role mappings are supplied.
AuthConfig layer names and ranks must match the configured ordered slots exactly;
unknown policy layers and nonempty write constraints reject at initialization.

Only the host's `onAuthorityReady(controller)` callback receives the controller,
after successful hydration. It provides `mint`, `revoke`, `replace`,
`forIdentity(token, { identity, namespace, viewId? })`, `forMutations(token)` and
`forSchemas(token)`. Tokens are empty, frozen objects
authenticated by membership in one root-local WeakMap. Serialization, copying,
cross-root reuse and structural schema validation cannot grant authority. The
root-independent capability schema rejects every value; the owning runtime uses
its own membership schema. Principal/grant DTO schemas validate shape only.
Snapshots detach and freeze principal roles, environment, ordered scopes,
namespace, operations, layers, views and expiry. `replace` revokes the old token
before capturing its replacement. Optional `now()` must return finite epoch
milliseconds; expiry and revocation are checked on each operation and again
after authorization. Already returned detached values cannot be retracted.

`forIdentity` is the sole host reader factory. It selects a namespace bounded by a
complete grant and an exact identity in the root environment. `prepare()`
checks a single complete read grant before provider I/O and after waiting;
`get`/`inspect` synchronously use the current published identity snapshot.
Unprepared cold identities fail `SCOPE_NOT_LOADED`. Its `selection` and revision
are read-only. No controller, token, registry, provider or writer is exposed.
Reads accept only literal relative segment arrays; `[]` addresses the selected
namespace. `get(segments, { layer?, defaultValue? })` replaces separate layer and
default methods. `snapshot(segments)` captures the requested subtree and its revision
together. An explicit `/` read grant is required for a full-root reader. Root reads,
old positional `forIdentity` and `bindRoot` have been removed without aliases.

Queries admit registered public primitives, objects, arrays and explicit permissive
JSON descendants, including canonical composition and pattern declarations.
Effective reads and inspection require one grant covering every selected
contribution layer; explicit layer reads require that exact configured layer.
Preparation conservatively requires all configured layers. Public aggregates use
the same pruned projection as individual reads, with host authorization for their
declared paths. Unauthorized aggregate branches are omitted; direct denied reads
throw and inspection redacts. Arrays are all-or-nothing, never compacted, sparse,
or filled with artificial nulls. Internal paths remain inaccessible. Session-bearing grants cannot read
through these ports. Unknown declared-path failures and canonical redaction are
not suppressed by defaults. No secret reference or raw schema data is exposed.

`forIdentity(...).validate(relativeSegments)` synchronously validates an exact registered
anchor against the current raw engine snapshot, with no provider IO. It requires
an inspect grant and read authority across the anchor subtree; schema-administration
permission alone does not grant it. Hidden, reference-tainted or undeclared data
cannot be used to expose validation details. Invalid public values return
`{ identity, revision, path, validation: { valid: false, errors } }`, not a rejected
mutation. Errors retain native codes and authorized paths but omit schema literals,
raw values and validator-specific messages. Cold identities must be prepared first.

### Captured views

`reader.forView(viewId)` replaces the view selection and `reader.forView()` selects
the base. Both return independent handles without I/O. Base grants use `views: []`;
named views require their exact IDs in separate grants. `*` has no wildcard meaning.
A named view must be prepared before reading, without an extra identity revision.

Both the logical namespace and `<namespace>/instances/<viewId>` must have actual
registered object-capable declarations. The same engine resolves base layers first,
then view layers, retaining original provider IDs and ranks. Thus a low-layer view
override wins over a high-layer base default. Objects inherit missing fields deeply;
arrays and null replace atomically. Denied overrides never trigger base fallback.
Inspection reports source-aware contributions and physical source paths rather than
guessing provenance from value equality. Ordinary reads cannot traverse `instances`.

View mutations use only `forMutations(token).apply`, with optional `viewId` on each
command and a logical path within its namespace. `remove` at the namespace resets
only the selected view's explicit layer; lower view layers and base defaults remain.
Patches operate on stored target-layer data, not a copied effective fallback object.
Base namespace replacement/removal preserves existing view storage; injected storage
payloads and unsafe atomic ancestor erasure reject before effects.

Prepared view snapshots stage with base data before publication, including batch
prefixes and observed readback. Schema changes rebuild them with current metadata;
an invalidated declaration makes the selection unavailable rather than preserving
old payload. Subscription registration and guarded queued delivery are reader-owned.
If either queued snapshot predates current registry policy, a still-readable selection
receives a value-free invalidation instead of historical values. Revoked, forbidden,
disposed or schema-fenced selections receive nothing. Data-only revisions retain
their original before/after values and revisions, with fresh host checks.

### Native publication and host lifecycle

`reader.onChange(relativeSegments, listener, { layer? })` is the only native
subscription API. `ConfigurationReaderChange` and `configurationReaderChangeSchema`
replace the former effective-change-only contract without an alias. The discriminant
is `kind: "effective" | "layer" | "invalidation"`. Every event identifies its captured
`selection`, logical `path`, `previousRevision`, `revision` and
`cause: "mutation" | "schema" | "reload" | "external" | "reconcile"`.

Effective events contain typed missing/value/redacted `previous` and `current`
values plus an authorized `reloadBehavior`. Equal projected values do not notify,
even if provenance changes. Explicit layer subscriptions require both read and inspect
permission and report only that layer's authorized source-aware contributions.
Invalidations contain `reason: "schema" | "stale"`, never values or changed-child
inventories. Arrays remain all-or-nothing. One accepted batch or confirmed prefix
publishes once; uncertain readback is an observation (`reconcile`), not a commit receipt.
Initialization, preload, rejection, explicit flush and acknowledgement emit no data event.

Listeners run after serialized publication completes; they can enqueue new work.
Their exceptions and rejected promises cannot change mutation outcomes. A live reader
may already see a newer revision than a queued event. Late subscriptions receive no
history. Unsubscribe and reader/root disposal cancel queued delivery; independently
derived readers own independent subscriptions. This confines trusted host capabilities,
not arbitrary JavaScript, and cannot retract copies already delivered.

`root.reloadProvider(id)` serializes a captured refresh (when present) and selected
provider read, stages all affected ready identities/views, and atomically publishes.
Context-independent fixed reads fan out; explicit read adapters run per full identity.
Failure preserves last-good payload/revisions and reports sanitized provider health.
Successful observation can repair ordinary load failure, not uncertain writes.
Changed/missing owned registry metadata fences reads rather than importing external
policy. Schema fences require recreation. Explicit reload under a write fence may
publish observed data but never restores write availability or proves old acceptance.

`root.flush()` is a FIFO drain plus one call to every explicitly declared required
writer flush hook, including declared borrowed writers. Undeclared hooks are untouched.
Failure attempts remaining hooks and fences uncertainty; it does not publish data,
retry mutations, clear fences or guarantee durability beyond the binding's contract.

Provider bindings opt into `watch: true`; the default is false. Hints are ignored as
data and trigger the same serialized read/validation/publication path, without refresh.
The root owns the returned unsubscribe, not a borrowed provider. Native filesystem
watch uses exclusive single-listener ownership, covers only its base file, and offers
no startup-ready/error handshake; repair may require resubscription/root recreation.
Alternate `load-layer` targets cannot opt into that watch. Git without a native watch
uses explicit reload/refresh; no polling or timer retry is invented. Hints under an
uncertainty fence are ignored.

Only the host root exposes `restartState: { revision, pending }`, where pending is
`none`, `rolling-restart` or `restart-required`. Effective changes in loaded identities
and prepared views accumulate the strongest registered inherited policy since the last
acknowledgement. `root.acknowledgeRestart(expectedRevision)` compares the current root
generation on the same queue; stale revisions conflict. It clears only the latch,
does no I/O or process restart, and cannot clear uncertainty fences. Reader event hints
cover only authorized changed data, never this global host state. HTTP/SSE/SCOMP and
SDK invalidation/reconnect consumption are not wired by this core API.

### Canonical ordered mutations

Supply `host.writers` with `{ providerId, operation: { kind: "write" },
flush: "none" | "required", failureSemantics: "unknown" | "rejected-means-no-effect" }`.
For an existing `load-layer` binding use `{ kind: "write-layer", layer }` with the
same exact provider dialect. Enabled bindings require a single explicit root
environment, `writable: true`, and captured callable write/remove methods; required
flush also requires a callable flush method. All bindings validate before provider
acquisition or hydration. Original method receivers are preserved, not frozen.
Custom read callbacks, common/multi-environment writable bindings and duplicate
writer declarations reject. Do not opt in adapters whose storage format differs
from nested entries; filesystem environment overlays and flat browser storage are
not writable adapters in this increment. Actual FS without an overlay supports both
ordinary and explicitly selected layer methods, including literal-dot/Unicode keys.

Obtain `controller.forMutations(token)` in trusted host code and invoke its sole
method, `apply(commands)`. A single mutation is a one-command list. The old native
root and identity-port `set`/`remove` methods and their write options/result DTOs
are removed; provider `WriteResult` is a separate, unchanged storage contract.

```ts
const mutations = controller.forMutations(token);
const result = await mutations.apply([{
  operation: "set",
   identity: query.selection.identity,
  namespace: canonicalConfigurationPathSchema.parse("/example"),
  layer: "settings",
  path: canonicalConfigurationPathSchema.parse("/example/config"),
  value: { enabled: true, values: [1, null] },
  ifRevision: query.revision,
}]);
```

Invocation captures immutable ordinary JSON commands and the original principal
before enqueueing once on the same data/schema/preparation FIFO. Getters, cycles,
sparse arrays, executable/exotic values and non-finite numbers reject before effects.
Replacing a token cannot upgrade already captured authority. Commands carry explicit
identity, namespace, layer and canonical path, never caller actors or roles.
Cold identities reject `SCOPE_NOT_LOADED` without implicit provider reads: explicitly
await the identity query port's `prepare()` first.
One complete grant must cover the requested identity, namespace, operation and layer;
grants cannot be combined. Fixed writes require an empty-scope request; scoped writes
select the deepest exact binding and never fall back to a writable ancestor.

`set` replaces a target-layer value, including objects, arrays and null. `remove`
deletes it and exposes lower-layer fallback. `patch` changes a value below a registered
anchor using that selected layer's raw anchor, not copied effective fallback data.
It supports array index replacement and append exactly at length, never holes.
Generic `set`/`remove` through array indices remains unsupported. Ordered overlapping
commands use successive draft states; each `ifRevision` compares the queue-entry
committed revision, not an invented intermediate revision.

All command prefixes, complete candidates, affected ready identities, schema and
host/policy checks finish before any provider effect. Before/after branch evidence
retains stricter old policies and destructive descendant restrictions. Patch policy
does not require authority over unchanged siblings carried in its anchor payload.
Sensitive writes require explicit sensitive grants, roles and host approval, without
implicitly granting sensitive reads. References, direct internal/instance storage paths, sessions, promotion and
emergency policies remain unavailable. Ceiling metadata still rejects at startup.

Canonical admission validates the full raw candidate layer and prospective effective
configuration for every loaded identity sharing the selected binding, using the same
configured resolver order as reads. Public redacted projections are never validation
inputs. All raw vectors, projections and one successor generation are staged before
dispatch. Required flush completes before a synchronous, callback-free publication.
Affected identities advance even for accepted no-ops; unaffected identities retain
their revisions. Fixed updates also feed future preloads; scope-prefix updates reach
loaded descendants selecting that physical binding. Native reader subscriptions receive
authorized effective changes or explicitly selected layer observations after publication;
equal projected values do not produce effective events. Transport feeds remain separate work.

Effects dispatch sequentially and stop at the first rejection, uncertainty or authority
loss. Every touched binding's required flush runs once, even after another flush fails.
Success returns `{ success: true, results, revisions }`. Receipts identify command
indices and report `committed`, `rejected`, `not-attempted` or `unknown`. Revisions
include only commanded identities, never other affected cached scopes.

Guaranteed no-effect rejection before acceptance returns `outcome: "rejected"`.
A known accepted and flushed prefix publishes once and returns `outcome: "partial"`
with its revisions and the actual stopping error. Throws, malformed results, ambiguous
rejection and failed required flush return `WRITE_OUTCOME_UNKNOWN` / `outcome: "unknown"`,
without accepted revisions. Independently flushed bindings may still have committed
storage receipts, but those do not authorize publishing a non-prefix logical subset.
Provider-specific messages are never forwarded. The error vocabulary is preserved:
unknown logical layers use `NOT_FOUND`, unavailable/read-only capabilities use
`WRITE_UNAVAILABLE`, and guaranteed provider rejection uses `WRITE_ERROR`.

Unknown outcomes fence all further writes and cold preloads, report degraded mode and
all touched provider IDs, and perform exactly one captured readback per touched binding
without retrying the mutation or flush. A completely valid observation publishes coherently; failed or
invalid observation retains every last-confirmed snapshot. Either way the result stays
unknown and the fence remains: readback does not prove durability. Recovery currently
requires host resolution and root recreation. Explicit reload may publish a validated
observation, but neither reload nor restart acknowledgement clears uncertainty fences.
Missing, invalid or changed co-located registry metadata additionally fences every
payload read; observation never silently installs another schema authority.
Revocation or disposal after dispatch cannot turn known completion into a claimed
rollback: accepted writes with completed required flush still return success. Disposal
fences access immediately and waits queued settlement before once-only owned cleanup.

Audit phases are best-effort observability, not authorization or commit proof. Both
audit and diagnostic failures preserve the operation's actual decision/outcome. The
executor rechecks authority after awaited pre-dispatch audit, so hook-driven revocation
still prevents dispatch. Audit records contain principal ID and request metadata, not
values/provider errors. Hooks must not await/reenter their root queue; synchronous
write reentry is denied. Standard same-realm `structuredClone` and Web Crypto are
required, not sandbox-replaced intrinsics. Explicit root reload invokes the captured
optional provider `refresh()` hook before reading and staging; external watch hints do
not invoke refresh. This adds no built-in remote Git management, server hosting, JWT
verification, distributed transaction or automatic replay. HTTP/SSE/SCOMP feeds and
SDK consumption remain separate work; restart acknowledgement performs no process action.

### Shared admission subpath

`@weaver-conf/config-service/admission` exports `prepareConfigMutation`, its narrow
registry/context/mutation/prepared-result types and native Zod schemas. This is a
trusted adapter admission helper, not an authorization or provider capability. The
legacy server delegates to this exact algorithm; its batch and dedicated mutation
semantics remain intact. `buildSchemaPatch` supplies shared pure value-patch mechanics,
not a second live writer. No service-to-server dependency is introduced.

### Owned live schema administration

The root owns exactly one canonical registry. `host.registry` accepts only data:
`{ initial?, storage?: { kind: "memory" } | { kind: "provider", providerId },
schemaIdentityMaxPageSize? }`. `initial` is persisted registry data decoded by
`@weaver-conf/config-registry/persistence`; it is not a callable reader. Omit it
to start empty or register `options.schemas` in caller order. Defined initial data
and nonempty seed schemas are mutually exclusive before ownership or I/O. Null,
malformed data and unsupported ceilings reject; they never become an empty store.
All input is detached. There is no reader-injection overload or external registry
lifetime requirement.

Memory is the default. Provider storage selects one existing fixed binding and
its captured `host.writers` declaration, including exact dialect and required
flush. Without a writer it supports browsing but registration rejects
`WRITE_UNAVAILABLE`. Provider-backed seeds finish persistence before readiness.
Registration stores v2 graph metadata at the internal `_weaver.registry.schemas`
key alongside—not instead of—application values. Existing v1/v2 data remains
readable. Public configuration paths cannot access this reserved metadata.

Mint explicit `schemaPermissions: ["read", "register"]` (or either permission)
and call `controller.forSchemas(token)`. Config operations do not imply schema
permissions, and schema permissions do not imply config operations. Schema target
grants use the existing namespace and environment with **empty scopePath**;
`operations: []` is valid for schema-only grants. No synthetic config namespace,
layer grant, session mode, owner name or role name grants schema access. The same
host callbacks additionally authorize discriminated `schema-read` and
`schema-register` requests. Hosts must handle those variants explicitly.

The schema port supplies `register(request, { ifRevision? }?)`, `snapshot()`,
`list(pageRequest?)`, `get(anchorPath, environment, { ifRevision? }?)` and a
read-only `revision`. Snapshot and list require grants covering the entire
committed catalog; otherwise they deny without returning partial pages, counts
or cursors. Exact detail and registration require their target grant. Snapshot is
an atomic array-based catalog including slot metadata; list is bounded identity
discovery; get is exact detail or null. These are distinct operations, not aliases.
Explicitly authorized metadata administrators receive schemas including defaults
and examples. Public config projection remains filtered independently.

Schema revisions combine root incarnation and committed registry generation.
Successful registrations, including no-ops, invalidate schema cursors; data-only
writes do not. Registration and configuration writes share the same FIFO. Before
any provider effect, registration prepares canonical metadata, encodes persistence,
stages every ready projection and fixed contribution for future preloads, and
prebuilds its result. Required flush precedes synchronous metadata/view publication.
New sensitivity therefore applies immediately to existing handles and layer views.
Registration preserves canonical breaking-change reporting; it does not add a
requirement that all old configuration values satisfy a changed schema.

Registration success includes `revision`, `isNewSchema`, `hasBreakingChanges`
and canonical `metadata`. Failure is `success:false`, `outcome: rejected|unknown`
and a sanitized typed error, never an accepted revision. Guaranteed no-effect
rejection preserves all views and cursors. An uncertain **schema** write fences
all schema/config payload reads and writes, including cached reads and preparation;
health remains observable and disposal remains available. Unlike value uncertainty,
there is no readback or automatic recovery under possibly changed disclosure policy.
Recovery requires host inspection of persistence and root recreation. A known
commit still returns its prebuilt result after post-dispatch revoke/dispose.

One root FIFO serializes preparation and mutations. Readers
look up current immutable identity snapshots; unrelated preloads do not change
the initial identity revision. Authority-enabled roots use opaque incarnation-
qualified revisions; lifecycle roots have no public revision or identity getter.
Callbacks are trusted, synchronous/non-reentrant for read authorization and
controller readiness, and must not mutate or await/reenter their root's queue.
Read callback exceptions, Promises and malformed decisions deny with static
errors. Readiness callback failure fences queued work and cleans every acquired
owned hook after settlement, preserving sanitized primary errors; borrowed hooks
are never closed. Keep host/controller references private: this is not a sandbox
against arbitrary same-realm code with access to the composition root.
