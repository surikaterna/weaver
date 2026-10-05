# @weaver-conf/config-service

`createConfigurationService(options)` awaits a provider-backed read-only root.
All synchronous reads and inspection use one canonical registered public projection
of the same engine-issued identity snapshot. The root exposes neither provider,
registry, client nor transport handles. No consumer namespace, environment or role
is built into the implementation.

```ts
import { createConfigurationService } from "@weaver-conf/config-service";
import { canonicalConfigurationPathSchema } from "@weaver-conf/config-types";

const root = await createConfigurationService({
  identity: { environment: "development", scopePath: [] },
  schemas: hostRegistrations, // ordered service, slot declarations, then fragments
  layers: [{ kind: "fixed", layer: "settings", providerIds: [provider.id] }],
  providers: [{
    id: provider.id, layer: "settings", provider,
    environment: { kind: "environments", environments: ["development"] },
    operation: { kind: "load" }, ownership: { kind: "borrowed" },
  }],
});
const path = canonicalConfigurationPathSchema.parse("/example/enabled");
const value = root.get(path); // synchronous, no provider/network operation
const inspection = root.inspect(path); // same identity/revision and provenance
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

`preloadScope` stages distinct identities FIFO and deduplicates pending/ready tuples.
Fixed contributions are retained, not reloaded on scope preload; accepted writes
update the retained vector used by future preloads.
Publication is atomic; failure leaves all existing identity snapshots unchanged.
The root describes its initial identity and that identity's current revision. Cold scope reads throw
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
host infrastructure. Root subscriptions are idempotent; initialization/preload
produces no fictional effective-change event.

The approved architecture uses this application authority for embedded and future
central hosting. The current server is **not yet migrated**; its future adapter
retains authentication, transports and durable bootstrap. One authoritative API
writer per backing configuration domain is a deployment responsibility, not a
distributed lock or multiwriter guarantee. Explicit out-of-band provider inputs may
later refresh through the authority publication path; this does not coordinate
concurrent API writers. There is no automatic hybrid mutation replay: pending is
not committed, required flush is not universal durability, and timeout after
dispatch is not rollback.

Without explicit host authority and writer opt-in, writes reject `WRITE_UNAVAILABLE`,
even for writable providers. Root reload/flush reject `UNSUPPORTED_OPERATION`;
after disposal these return `DISPOSED`. Scoped/service factories, ceiling integration, reload/restart notifications and
sessions remain successor work, not alpha/product readiness claims. Production
imports no filesystem, storage aggregate or server package. Node hosts may inject
the public filesystem provider and explicitly map its construction-time environment
overlay and `loadLayer` file dialect.

The unpublished source seed is `0.0.0`, `private:false`, public access, with a minor
changeset. No version application or publication is authorized by this package.

## Trusted host authority

`createConfigurationService(options, host?)` accepts an optional second,
service-owned `ConfigurationServiceHostOptions` argument. The original native
`ConfigurationServiceOptions` schema and one-argument behavior are unchanged.
The root exports exactly the factory and `configurationServiceHostOptionsSchema`;
principal, grant, request, decision, audit and writer-binding DTOs and their native
Zod schemas are exported by `@weaver-conf/config-types`.

The host is trusted composition code, not consumer configuration or proof of an
external identity. An authority binding requires explicit `authConfig` and both
`hostAuthority.authorizeReadSync` and `hostAuthority.authorizeWrite`. Decisions
are the strings `"allowed"` or `"denied"`. Callbacks can narrow grants, never
declassify the canonical public projection. No default role mappings are supplied.
AuthConfig layer names and ranks must match the configured ordered slots exactly;
unknown policy layers and nonempty write constraints reject at initialization.

Only the host's `onAuthorityReady(controller)` callback receives the controller,
after successful hydration. It provides `mint`, `revoke`, `replace`, `bindRoot`
and `forIdentity(token, identity, namespace)`. Tokens are empty, frozen objects
authenticated by membership in one root-local WeakMap. Serialization, copying,
cross-root reuse and structural schema validation cannot grant authority. The
root-independent capability schema rejects every value; the owning runtime uses
its own membership schema. Principal/grant DTO schemas validate shape only.
Snapshots detach and freeze principal roles, environment, ordered scopes,
namespace, operations, layers, views and expiry. `replace` revokes the old token
before capturing its replacement. Optional `now()` must return finite epoch
milliseconds; expiry and revocation are checked on each operation and again
after authorization. Already returned detached values cannot be retracted.

`forIdentity` is a host request port, **not a public consumer factory**. It selects
an exact granted namespace and identity in the root environment. `prepare()`
checks a single complete read grant before provider I/O and after waiting;
`get`/`inspect` synchronously use the current published identity snapshot.
Unprepared cold identities fail `SCOPE_NOT_LOADED`. Its identity and revision
are read-only. No controller, token, registry, provider or writer is exposed.
Use request-local ports for concurrent host requests, not per-request global
`bindRoot`. Root binding gates all existing value/default/layer/namespace/scope/
inspection/subscription/preload surfaces; queued preparation retains its original
token even if the root is rebound. Without binding, host-owned root public reads
retain the original read-only behavior.

This increment admits only concrete registered **public primitive/null leaves**.
Effective reads and inspection require one grant covering every selected
contribution layer; explicit layer reads require that exact configured layer.
Preparation conservatively requires all configured layers. Privileged aggregate,
view/instances, sensitive, internal and ambiguous schema paths fail closed; they
are not enabled by roles or session metadata. Session-bearing grants cannot read
through these ports. Unknown declared-path failures and canonical redaction are
not suppressed by defaults. No secret reference or raw schema data is exposed.

### Opt-in primitive writes

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

With a bound capability, both `root.set/remove` and request-port `set/remove` use
one FIFO executor. The invocation captures its token, detached principal, identity,
primitive value and strict `{ layer, ifRevision? }` options before enqueueing.
Later `bindRoot` calls cannot change queued authority. Actor/roles/environment/scope/
session overrides are not write options. Cold request identities reject
`SCOPE_NOT_LOADED` without implicit preparation or reads: explicitly await `prepare()`.
One complete grant must cover the requested identity, namespace, operation and layer;
grants cannot be combined. Fixed writes require an empty-scope request; scoped writes
select the deepest exact binding and never fall back to a writable ancestor.

Each operation checks current revision, root health, registry/rank stability and
capability expiry/revocation, awaits host `authorizeWrite`, and checks again. The
same configured `withAuth` and `evaluateChangePolicy` apply to every concrete schema
ancestor and leaf. Only declared public primitive/null leaves are supported, including
removal of missing optional leaves. Objects, arrays/indices, views, composition-dependent
targets, atomic ancestor replacement, batches, sessions, emergency overrides and
promotion-required policies are rejected before effects. Ceiling metadata still
rejects at factory initialization; it is not bypassed for writes.

Canonical admission validates the full raw candidate layer and prospective effective
configuration for every loaded identity sharing the selected binding, using the same
configured resolver order as reads. Public redacted projections are never validation
inputs. All raw vectors, projections and one successor generation are staged before
dispatch. Required flush completes before a synchronous, callback-free publication.
Affected identities advance even for accepted no-ops; unaffected identities retain
their revisions. Fixed updates also feed future preloads; scope-prefix updates reach
loaded descendants selecting that physical binding. No effective-change event is
emitted yet: consumers must explicitly reread; notification semantics remain future work.

Success is exactly `{ success: true, layer, revision }`, using the service incarnation/
generation rather than provider revision. A provider `success:false` is rejected only
when the host explicitly guarantees no effect. Throws, malformed/contradictory results,
ambiguous rejection and required-flush failure return `WRITE_OUTCOME_UNKNOWN` with
`outcome: "unknown"`; no accepted layer/revision is fabricated. Provider-specific
messages are never forwarded. The existing public error vocabulary is preserved:
unknown logical layers use `NOT_FOUND`, unavailable/read-only capabilities use
`WRITE_UNAVAILABLE`, and guaranteed provider rejection uses `WRITE_ERROR`.

Unknown outcomes fence all further writes and cold preloads, report degraded mode and
the affected provider ID, and perform exactly one captured readback without retrying
the mutation or flush. A completely valid observation publishes coherently; failed or
invalid observation retains every last-confirmed snapshot. Either way the result stays
unknown and the fence remains: readback does not prove durability. Recovery currently
requires host resolution and root recreation, not an invented reset/reload API.
Revocation or disposal after dispatch cannot turn known completion into a claimed
rollback: accepted writes with completed required flush still return success. Disposal
fences access immediately and waits queued settlement before once-only owned cleanup.

Audit phases are best-effort observability, not authorization or commit proof. Both
audit and diagnostic failures preserve the operation's actual decision/outcome. The
executor rechecks authority after awaited pre-dispatch audit, so hook-driven revocation
still prevents dispatch. Audit records contain principal ID and request metadata, not
values/provider errors. Hooks must not await/reenter their root queue; synchronous
write reentry is denied. Standard same-realm `structuredClone` and Web Crypto are
required, not sandbox-replaced intrinsics. There is still no server hosting, JWT
verification, provider refresh, distributed transaction or automatic replay here.

### Shared admission subpath

`@weaver-conf/config-service/admission` exports `prepareConfigMutation`, its narrow
registry/context/mutation/prepared-result types and native Zod schemas. This is a
trusted adapter admission helper, not an authorization or provider capability. The
legacy server delegates to this exact algorithm through a thin re-export; its batch
and dedicated mutation semantics remain intact. Primitive-only restrictions belong
above the helper in the governed root. No service-to-server dependency is introduced.

An optional `host.registry` is the actual trusted canonical registry reader,
used unchanged for admission and projection. Supplying it together with nonempty
`options.schemas` rejects before configuration I/O. All registered anchors across
all environments are scanned for unsupported ceilings before loads. Hosts must
keep the registry stable for the root's lifetime; observable identity/schema/
metadata changes fail closed. No second registry or live schema administration
API is created. The stability check compares canonical reader results, not an
invented registry generation counter.

One root FIFO serializes preparation and mutations. Readers
look up current immutable identity snapshots; unrelated preloads do not change
the initial identity revision. Authority-enabled roots use opaque incarnation-
qualified revisions; ordinary one-argument revision behavior is unchanged.
Callbacks are trusted, synchronous/non-reentrant for read authorization and
controller readiness, and must not mutate or await/reenter their root's queue.
Read callback exceptions, Promises and malformed decisions deny with static
errors. Readiness callback failure fences queued work and cleans every acquired
owned hook after settlement, preserving sanitized primary errors; borrowed hooks
are never closed. Keep host/controller references private: this is not a sandbox
against arbitrary same-realm code with access to the composition root.
