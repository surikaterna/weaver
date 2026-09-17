# Code-defined internal catalog

`weaver-lyg0` supplies the catalog/contracts foundation for PR #152 / `weaver-s62`.
It does not activate a registry, construct providers, write metadata, or implement
maintenance execution. Those actions belong to the canonical pipeline and
bootstrap/upgrade workstreams.

## Protected tree

One seed-owned control layer contains this logical `_weaver` subtree:

```text
_weaver/
  format
  catalog/registrations/<recordId>
  infrastructure/activeGeneration
  infrastructure/generations/<generationId>
  scopeInventory
  upgrades/plans/<planId>
  upgrades/journal/<runId>
```

Every metadata object has a strict, co-located Zod contract in config-types.
Unknown metadata children, stored schema documents, serialized functions, and
factory import/module paths are rejected. Raw application values are permitted
only in the explicitly JSON-valued upgrade mutation/undo fields and existing
registration schema contracts; they are not metadata-validation exemptions.
The new contracts do not read or translate legacy registry/bootstrap models.

`format` is `{version:1, storeId, environment, initialization, builtinCatalog}`.
Its version is distinct from provider `storageFormat`. `initialization` is
`uninitialized` or `initialized`; absence defaults to **uninitialized**, never
ready. The code catalog reference contains `id`, `version`, and SHA-256 `digest`.
Version discriminators are required and are never defaulted into versionless
records; the catalog does not provide a legacy compatibility path.
Stored values must match the code pin and external seed store/environment
binding. They never select executable validators.

Registration records contain `{version:1, kind, request, audit}`. `request` is
the existing matching service/fragment registration contract; `audit.actor` is
required, with optional `subject`. Record IDs are lowercase hexadecimal UTF-8
of JSON `[environment, kind, serviceId, slotPath-or-empty, providerId-or-empty]`.
Canonical paths and slots are derived from those requests, not stored as a
second authority. Compilation uses the existing supported grammar, default
validation, and parent/slot composition, without a runtime registry instance.

## Infrastructure and references

A generation contains `version`, `layout`, `providers`, and `server`. Layer
array order alone defines rank through `defineWeaver`; extra rank fields and
duplicate names are rejected. `compileInternalLayout` binds existing `Layers`
definitions and their installed `deep` merge semantics. It validates scope
references/hierarchy and refuses personal/ephemeral types until resolver support
exists. This is definition compilation, not provider I/O or a claim that the
current placeholder resolver implementations have been replaced.

The initial serialized factory profiles are closed:

| Factory | Options | Credential references |
| --- | --- | --- |
| `fs` | `filePath` | none |
| `git` | `localPath`, `filePath`, `authority:local-durable`, optional HTTPS `remote` | optional `token` |
| `mongodb` | `database`, `collection` | required `connection` |
| `memory` | `durability:volatile` | none |

URLs cannot carry userinfo/query/fragment credentials. Runtime binding of these
profiles to installed providers, ownership, scope I/O and capacity remains a
pipeline responsibility; serialized definitions cannot claim those capabilities.
Server settings contain a bounded port, optional CORS origins and authentication
credential reference/admin roles. Defaults provide port 3399 and role `admin`
only when their parent objects exist; no credential or parent is invented.

Scope inventory reuses the existing version/revision/full-context contract.
The catalog boundary additionally enforces canonical full-vector IDs, no
duplicate dimensions, active prefixes and declared hierarchy/order. Base is
implicit; it does not invent Cartesian products or infer inventory completeness
from warmed scopes.

## Code source and engine boundary

`getBuiltinCatalogSource()` exposes frozen code-owned contract descriptors and
immutable parser/JSON-description views, not shared mutable Zod instances.
Trusted parsing uses captured library parsing functions rather than looking up
replaceable `safeParse`/`parse` methods on exported schema objects. The ordinary
co-located Zod exports remain useful to callers but cannot replace these trusted
parser methods. Parser graphs, nested definitions/checks/regexes, and lazy
cycles are snapshotted privately before views are exported, so later mutations
of public Zod shapes do not change trusted validation either. Binding, layout,
and default-annotation compiler inputs use these same private views.
Application schemas are deeply frozen values in an immutable
`ReadonlyMap` facade, not a mutable Map cast readonly.
`builtinCatalogManifest()` describes their serialized grammar and default
annotations. Its canonical JSON SHA-256 must match `BUILTIN_CATALOG_REFERENCE`;
the pin is tested. Code-semantic refinement changes require an intentional
catalog version/digest review even when JSON Schema serialization is unchanged.

Each descriptor has an immutable `schema` view of its strict Zod contract and a supported property-schema
`defaults` annotation tree. The latter preserves other fields during default
materialization; it is **not** an authorization schema. Engine
`compileBuiltinContract` validates its grammar and recursive defaults, clones
and materializes input using the existing absence-only engine, then necessarily
validates the complete result with the strict code contract. Invalid defaults,
marker-producing defaults, unknown metadata and invalid existing values refuse.
Compilation also checks each annotated default against its actual strict leaf
contract, traversing optional objects, records and array items without inventing
unrelated required siblings. Unknown default branches and version-discriminator
defaults refuse even when their annotation alone would accept them.
The validated returned state is deeply frozen; caller inputs are not modified.

The server exports:

- `builtinCatalogReference()` — verifies and returns the code pin.
- `prepareBuiltinCatalog(rawWeaverSubtree, expectedBinding)` — validates the
  complete control state and pin, compiles derived application schemas and
  existing layer definitions, and returns those prepared values without I/O.
- `readBuiltinRecoveryEnvelope(rawJournalRecord)` — independently validates
  the version-1 recovery envelope through the same engine contract compiler.

The next pipeline must call preparation **before** public registry activation.
Missing/invalid/uninitialized catalogs cannot return a prepared catalog. This
API does not toggle current server readiness: provider ownership, coverage,
resolution, activation fencing and startup wiring remain separate work. It
uses existing `SERVER_DEGRADED` for unready binding/initialization and
`VALIDATION_ERROR` for invalid data, rather than introducing transport mappings.

## Planning and pinned recovery

Plan contracts bind catalog/data digests, typed provider revisions, inventory
revision, infrastructure generation, full contexts and physical targets.
Plan IDs are SHA-256 of canonical JSON of the complete body without `id`;
preparation verifies body/record IDs and step revision membership. Mutations
are raw `set(value)` or `remove`, addressed solely by `target.path`; the future
executor derives provider keys. Reversible steps require explicit undo, and
semantic no-op steps are forbidden. Normal optional application properties
without defaults remain legal; deciding that newly governed optional fields
block automatic migration belongs to the planner, not catalog registration.

Every source revision must belong to the enclosing catalog environment and a
provider declared by the plan's retained source generation. That generation
must exist but need not be active. Duplicate/contradictory provider inventories,
physical aliases, inconsistent store IDs, and unbound data digests/steps refuse;
recomputing a plan ID does not waive these bindings. When the plan is available,
journal steps must match its ordered target/mutation/digest/undo declarations.

Journal records are the recovery envelope, not a sidecar. Phases and step
statuses are discriminated contracts; completed steps require coherent
operation/receipt identity and consecutive receipt sequence. Prepared steps are
pending, final phases contain completed steps, and completion is a contiguous
prefix with at most one outstanding intent. Recovery has a code-pinned 4 MB
envelope bound and 1000-step bound. Capacity/receipt ownership reconciliation
and crash-safe CAS execution are not implemented here.

`intentOperationId` identifies the control-envelope intent commit; its receipt
is read from durable authority evidence, not recursively embedded as its own
receipt. Data completion records include the returned data receipt. The future
executor must preserve the rolling revision cursor and same-control-provider
lineage rules from `weaver-ekin`, not reuse stale planned stamps after self-writes.

The pinned reader reconstructs each completed data request using the canonical
storage key derived from `target.path`, its operation ID, recorded mutation and
receipt's exact previous revision. It uses the existing provider
`computeProviderMutationDigest` implementation; another value, path, request
alias, or expected revision cannot reuse that receipt. Non-control data receipts
must start at `preRevision`. Same-control data receipts must instead start at
the recorded intent receipt, whose previous revision is `preRevision`.

Optional `sourceRevisions` records anchor untouched dependency cursors. Optional
`control: {providerId, revision, receipts}` records the control authority's
starting stamp and acknowledged bookkeeping receipts. These join completed
data receipts into contiguous, identity-preserving timelines; cursors must
match every timeline tip exactly. Arbitrary advances, foreign stores/environments,
duplicate or omitted cursor entries, and missing intent links refuse. The
declared completed data-step order must also follow each authority's receipt
lineage; sorting to merge bookkeeping cannot legitimize reordered data writes.
Independent providers may interleave, and recorded control bookkeeping may
advance an authority between its data steps.
The control binding is checked against the control-layer identity during normal
preparation. Its source stamp must match the plan when the plan is available.

The journal cursor describes the acknowledged prefix recorded in that journal;
the receipt for the write containing the journal belongs to the outer provider
envelope, not recursively inside its own payload. The executor must verify that
outer receipt and advance its in-memory rolling cursor after each write. Static
validation does not authenticate supplied receipts or prove ownership: live
recovery must match recorded bookkeeping/data receipts against durable provider
evidence under the retained exclusive owner before taking action.

This catalog-only API addition uses a minor changeset. Existing integrated
foundation changesets continue to determine the overall PR's major release.

Recovery validation never consults the active or target application catalog.
It remains usable when normal preparation refuses a missing/corrupt catalog,
plan, or partially migrated target. Target catalog references are inert typed
references, not code selectors. Raw references may remain in journal mutations;
resolved secrets must never be collected into plans/journals. Raw-provenance,
automatic-placement is implemented by the pure planner; operator-approved
transform/reset execution remains in `weaver-ekin`.

## Dry-run upgrade planning

`buildUpgradePlan(input)` is a pure config-engine boundary. Its strict input
contains only JSON schema/catalog/layout/inventory records, immutable raw layer
snapshots, physical namespaces and authority revisions. It accepts no provider,
clock, random source, secret resolver or write callback. Newly introduced or
newly named-governed properties require an **own** valid typed default whether
required or optional. Existing own values, including `null`, `false`, `0`, empty
strings/arrays/objects, are never replaced. Arrays are indivisible; open and
pattern governance is refused because it cannot be finitely enumerated.

The planner groups insertions into full raw anchor replacements so existing
siblings survive. It chooses the lowest durable writable non-control physical
layer visible to every affected active, cold or retired context. It never emits
per-tenant writes when there is no single shared physical target. Read-only,
volatile, ambiguous, ancestor/array overwrite, secret-marker, incompatible
existing, removal/rename and stale binding cases return typed refusals. Explicit
transform/reset dispositions are reported but not executed in this issue.

## Maintenance execution and recovery

`WeaverRuntime.applyUpgrade()` closes application admission before recomputing
the supplied planning request. A stale request is rejected before any plan,
journal, schema or data write. Accepted plans and journals use the same protected
control transactions as all other internal state. Each ordered step persists an
intent, conditionally commits through the validated transition pipeline with the
recorded operation ID, validates the provider receipt and raw post-digest, then
persists completion before the next step.

The barrier drains the shared operation coordinator, stops provider watches and
managed timers, flushes dirty buffers, and closes pending or active SSE and SCOMP
subscriptions. Ordinary HTTP and SCOMP operations receive `MAINTENANCE`; upgrade
administration remains available through authenticated REST routes and bounded,
owner-only CLI JSON inputs.

Final activation validates base and all inventoried contexts under the target
catalog before persisting activation intent and conditionally replacing the
control root. Application-only upgrades reopen admission. Built-in or
infrastructure activation remains `restart-required`. Recovery uses only the
code-pinned envelope, requires explicit prior-owner-stopped evidence for owner
adoption, and recognizes committed data only from exact operation receipts and
raw post-state. Conflicts and uncertain reads remain blocked. Explicit
compensation applies recorded undo operations in reverse completion order; it
does not claim cross-provider atomicity. There is no legacy conversion,
automatic reset, online migration, tenant fan-out or automatic lock stealing.

`WeaverRuntime.planUpgrade(request)` takes a coordinator-held stable snapshot of
the control projection and every provider inventory/layer envelope, checks the
inventory again after reads, parses the complete planner input and invokes the
pure engine. It does not enter maintenance, warm scopes, persist plans/journals,
commit/flush providers, publish projections, alter revisions or emit SSE. The
matching admin and CLI entry points invoke these same runtime APIs.
The snapshot collector is server-private and is not part of
`WeaverConfigService`. Full-anchor plans refuse when an existing sensitive field
or raw secret/mount marker would otherwise be copied into mutation or undo data.
