# Provider authority (PR152 core foundation)

Tracking: **weaver-le5y, weaver-dpd6, weaver-913w, weaver-54ud, weaver-69k**, under **weaver-s62**.

## Contracts and commit boundary

`ConfigurationStorageProvider.authority` is an executable capability, not a promise inferred from `writable`, `dirty`, or `flush`. Its descriptor and all serialized requests, envelopes, receipts, inventories and snapshots have exported Zod schemas in `config-types`. The executable methods and reference-identity `ProviderWriterHandle` are intentionally not serialized.

The methods are `preflight(layers?)`, `acquireWriter(ownerId)`, `releaseWriter(handle)`, `readLayer(layer)`, `inventory()` and `commitLayer(request, handle)`. The request contains a physical layer, exact `expectedRevision`, UUID `operationId`, and a JSON `set` or `remove` mutation. Direct `write`/`remove`/scoped methods delegate to this same implementation and **refuse** while a service owns the provider. Close the service before starting another owner. Concurrent direct calls may explicitly conflict; they never silently overwrite a successful sibling operation.

All descriptor/composition/catalog checks and all read-only provider preflights complete before the first acquisition or initialization. Preflight reports the canonical namespace, complete planned physical layers and existing/fresh/volatile initialization mode. Static scoped providers must be catalogued just like dynamic ones; retired layers are inventoried but cannot be written. A read-only API facade over mutable storage still holds an exclusive writer capability. No read-only flag is interpreted as an immutable pin.

An envelope atomically stores:

```text
storageFormat: 1
storeId, environment, layer, epoch: UUID, sequence: canonical decimal string
entries: JSON object
lastCommit?: { operationId, previousRevision, revision, mutationDigest }
```

`storeId` binds the actual backend locator, not its display ID. Reads return detached snapshots. A real entry change increments the sequence, including deletion of all entries (an empty envelope is retained). No-op writes persist their receipt without changing the data revision. The latest exact operation can be replayed; reuse with different input conflicts. Only the latest receipt is retained: this is **not** an unlimited idempotency log. A maintenance executor must journal each completed step before beginning another.

Public `authority-v1.*` revisions encode an ordered provider vector, infrastructure identity and inventory revision. They are opaque equality tokens, not timestamps or content hashes. No-op reads/reloads/refreshes and acknowledged restarts retain durable revisions. A→B→A does not revive A's old token. The mutation digest is SHA-256 of canonical request JSON for receipt diagnostics, **not** CAS authority. Basic providers without authority use explicitly volatile per-service epochs/sequences; their revisions make no restart or cross-process promise.

`COMMIT_OUTCOME_UNKNOWN` means effects may have occurred. Neither the adapter nor the core claims rollback. Core retains its last installed state but denies public reads/writes and reload recovery for that service instance. Inspect the stored receipt and establish safe ownership before controlled restart/reconciliation. A failed Git push is different: local mutation was durably acknowledged; replication remains dirty and retryable.

## Adapter support

| Adapter | Authority support | Limits |
| --- | --- | --- |
| In-memory | Volatile exclusive, instance-bound ownership, conditional commits and receipts | No durable bootstrap/apply; epoch changes with a new memory store. Physical layers can be materialized in memory before readiness. |
| Filesystem, `authority` option | Durable exclusive on a dedicated persistent **local** directory | No NFS/distributed filesystem claim, overlays, unmanaged files, symlinked envelope files, or automatic stale-lock takeover. All physical layers are declared. |
| Git, `authority` option | Same filesystem authority, in a dedicated data subdirectory of a persistent local checkout | Local fsync is the boundary. Remote replication is separate; scoped paths remain pending on failed push. Provider refresh does not pull, and revert/reset is refused. External checkout/pull/reset or editing while owned is unsupported. |
| Mongo, `authority` option | One envelope per environment/layer; unique compound index; owner+fence+epoch+sequence in the same atomic update; majority+j acknowledgement | **Replica sets only**. Standalone is refused. Complete envelope is bounded below 16 MB (BSON checked as well as serialized capacity). Fixed declared layer inventory. No transactions, expiring leases, automatic owner transfer, or legacy conversion. |
| Plain JSON / old Mongo root-key | Removed; explicit unsupported-format refusal only | No reader, cleanup/converter, or automatic adoption. Source data remains untouched. |
| Custom providers without authority | Explicit embedded use only | No standalone durability or distributed guarantee. |

Filesystem commits use a unique temporary file, file fsync, rename and parent-directory fsync. Created directory ancestry is synced. One exclusive directory lock covers the entire provider namespace, including scope files. The lock is held for the service lifetime. Release revokes the handle and its backend token **before** removing the lock. Failed release is quarantined even when removal succeeded but parent sync failed: retrying the old handle cannot delete a successor's lock. There is no filesystem `releaseQuarantinedWriter` recovery; it refuses instead of blindly repeating pathname deletion. After process termination the lock remains; **elapsed time is never permission to remove it**. An operator must first prove the prior writer has stopped and inspect the receipt/data. An uncooperative writer with direct filesystem permissions is outside the support model.

Mongo authority opens the named collection using the explicitly supplied `MongoClient`, derives its store identity from the configured hosts and database/collection namespace, and verifies replica-set topology with `hello`. Existing stores must have a compatible complete unique environment/layer index (no sparse, partial or non-simple-collation substitute) before ownership changes. Different connection-locator spelling is not transparent store adoption. Missing/corrupt initialized documents and old root-key documents refuse adoption without deleting operator data. A lost Mongo fence prevents further conditional mutation.

Ownership attempts record owner UUID, previous/new fence and phase before IO. Potentially applied acquisition/release failures are typed `COMMIT_OUTCOME_UNKNOWN`, retaining all attempted-layer evidence. `inspectOwnership()` validates a read-only snapshot indicating owned, released, not-applied, lost or unknown observations. The same adapter instance can explicitly invoke `releaseQuarantinedWriter()` to conditionally release only its recorded owner/fence tuples. It attempts independent layers even if one fails, never resets another owner, and never revives an old writer handle. This is controlled cleanup, not takeover or transparent acquisition retry. Automatic recovery, arbitrary owner transfer and filesystem lock recovery remain unsupported.

An observed `not-applied` acquisition is not proof that the write has completed. Recovery atomically clears this instance's acquired tuple **or advances its previous unowned fence**, with majority+j acknowledgement, before settling the attempt. A held acquisition using the old precondition then cannot apply; data sequence and mutation receipt do not change. An initiating conflict remains the primary diagnostic even if abort cleanup is uncertain: retained backend ownership state independently quarantines the adapter, so exact-fence recovery stays available instead of being inferred solely from the outer error code.

Git authority uses the production manager's `commitAndReplicate` path, which never pulls/rebases/checks out/resets. The provider retains checkout-mutation admission through `retainLocalAuthority` while it owns the namespace; manager `ensureClone`, `refresh`, ordinary `commitAndPush`, and `revert` refuse while pinned. Failed replication keeps pending paths and retries push without requiring another data mutation or empty commit.

Service close shuts admission immediately, drains accepted work, then attempts every independent replication flush, owner release, runtime disposal and server/bootstrap cleanup. Failures preserve the initiating error and structured cleanup diagnostics. Cleanup is not blindly retried, and pending replication stays visible on the provider. Core validates complete read envelopes, exact captured identities and commit response schemas, receipt identity/digest/content/sequence and acknowledgement mode before installing state. A malformed possible-applied response makes the service nonready without publishing or claiming rollback.

## Explicit initialization

FS/Git/Mongo factories now require current-format authority options. `initialize: true` means **explicitly initialize an empty new namespace**; it never converts existing documents. Existing nonempty legacy stores must be preserved and a new target explicitly initialized through [seed bootstrap](guides/bootstrap-config-repo.md).

```ts
const provider = createFileSystemStorageProvider({
  id: "platform-local",
  layer: "platform",
  writable: true,
  filePath: "/persistent/weaver/platform/entries.json",
  authority: { environment: "production", initialize: true },
});
```

Provider construction is not application initialization. Use the explicit
[standalone seed initialization procedure](guides/bootstrap-config-repo.md) to install
validated canonical state before opening application admission; close the shared
service to release ownership. Ordinary application startup never invents a catalog.

For Mongo, provide `authority: { client, initialize: true, layers: [...] }` to `createMongoDBStorageProvider`. For Git, provide filesystem authority options with `filePath` pointing into a dedicated checkout data subdirectory. `environmentOverlayPath` and plain/root-key readers are removed. Immutable pinned inputs remain reserved but unimplemented; durable admission never equates a read-only facade with immutable data.

Restoring a backup into the same locator is not transparent revision replay. Recovery/reset must establish a new epoch through an explicit, controlled bootstrap; this foundation does not expose a destructive reset or migration API.

## Scope inventory and service coordination

`scopeInventory` is a validated snapshot: `{version:1, revision:decimal, contexts:{id:{scopePath,state,displayName?}}}`. Base `[]` is implicit. IDs are lowercase hex UTF-8 of canonical JSON pairs `[[scopeId,value], ...]`. Every supported full combination and its valid prefixes must be listed explicitly. Supported identifiers are deliberately bounded to unambiguous ASCII values; no Cartesian product is inferred from warmed dimensions. Retired physical stores remain inventoried and revision-bound but are not served. Unknown contexts are refused.

The service compares every referenced physical store (including cold/retired stores) with persisted canonical inventory and captures all stamps before readiness. `authoritySnapshot()` returns a schema-validated catalog, descriptor/inventory map and matching public revision, or refuses unknown/incomplete/unsupported authority. A changed provider inventory invalidates preflight. The integrated lifecycle activates prepared stores through a conditional inventory mutation; it cannot implicitly create unknown stores. See [canonical pipeline](validated-control-pipeline.md) for registration/activation and the separately bounded maintenance primitive.

`assertScopeMembership(scopePath?, signal?)` is executable, read-only transport admission, not a serialized contract or a catalog update. REST/effective reads and SSE call it before warming or subscription. Persisted exact active full contexts are authoritative: neither legacy markers nor explicit scoped providers admit retired or unlisted contexts. Missing canonical inventory is nonready, not marker fallback. SSE cancellation does not enter the mutation coordinator or wait for an in-flight provider read to finish.

Core has one non-reentrant coordinator covering read, expected-revision check, target read, registered patch derivation, validation, provider commit, live installation and ordered mutation projection. Internal config, registry and scope lifecycle writes use that same queue and candidate pipeline. `setMany` prevalidates all paths and checks the expected vector once, then commits an ordered prefix; it is **not transactional** and failures report the current revision. It never rolls back already acknowledged items or introduces a registry-only CAS engine.

## Corruption and validation policy

Malformed paths resolve `WriteResult` validation failures before storage/session selection. Mongo validates complete envelopes and refuses root-key/alias documents without interpreting or cleaning them. Required-provider startup failure rejects initialization; a failed staged reload retains old in-memory data but denies public reads and publication instead of silently serving a weaker layer stack. Successful controlled reload recovers ordinary load failures. No provider or core corruption path deletes or repairs source data.

## Verification

New tests use `node --test` through package scripts after the repository's inherited Vitest suites. Real filesystem tests cover restart, competing subprocess writers and termination with a retained lock. Mongo integration tests use only unique `weaver_core_test_*` databases on the explicitly supplied test URI and drop those test databases afterward.

```sh
WEAVER_TEST_MONGO_URI='mongodb://127.0.0.1:27028/?directConnection=true' \
  pnpm exec turbo run test --filter=@weaver-conf/weaver-server... \
  --filter=@weaver-conf/config-sessions... --force --env-mode=loose
```

Without that URI the real Mongo cases are explicitly skipped, not counted as live-service coverage. Tests exercise the protocol on a local single-member replica set; they do not simulate physical power loss, NFS behavior or multi-node failover. Those are not claimed by this evidence.
