# Explicit seed bootstrap and lifecycle

Current API for **weaver-qkmd / weaver-mic8 / weaver-2q6b**, under **weaver-s62**. The old repository bootstrap and implicit-memory startup are removed. This is a pre-release breaking change, not a compatibility migration.

## Trust and the external seed

Only version, environment, the control-store locator and credential **references** belong outside Weaver. Keep the seed and initialization input in owner-only regular files (`chmod 600`); the CLI opens with `O_NOFOLLOW | O_NONBLOCK`, checks the opened inode's type/owner/permissions, and bounds actual bytes through EOF even if the file grows after inspection. FIFOs without writers refuse promptly rather than blocking open. POSIX local files are the tested profile. Never put passwords, JWT keys or connection strings in the seed or generation.

`/etc/weaver/seed.json`:

```json
{
  "version": 1,
  "environment": "production",
  "store": { "factory": "fs", "locator": { "filePath": "/var/lib/weaver/control/entries.json" } },
  "trust": { "adminCredentialRef": "administrator" }
}
```

The injected `BootstrapCredentials.resolveCredential(ref)` is an executable code boundary, never code installed from JSON. The CLI maps a reference `jwt` to `WEAVER_CREDENTIAL_jwt`. A separate `WEAVER_ADMIN_CREDENTIAL` proves administration for initialization. Administrative capabilities are opaque, process-local, seed-bound objects minted by `authenticateBootstrapAdministrator`; an actor string or JSON object cannot forge one. Credentials are bounded by a startup deadline and cannot recursively load themselves from Weaver.

## Declarative initialization

`/etc/weaver/initialize.json` uses the existing serialized LayerDefinition model. The layer array is the **only** rank/order authority. The reserved static `control` provider must match the seed exactly and cannot carry application data.

```json
{
  "generationId": "g1",
  "generation": {
    "version": 1,
    "layout": {
      "layers": [
        { "name": "control", "type": "static", "providerId": "control", "config": { "mergeId": "deep" } },
        { "name": "platform", "type": "static", "providerId": "platform", "config": { "mergeId": "deep" } },
        { "name": "tenant", "type": "dynamic", "providerId": "tenant", "config": { "mergeId": "deep", "scopeIds": ["tenant"] } }
      ],
      "scopes": [{ "id": "tenant", "label": "Tenant" }]
    },
    "providers": [
      { "id": "control", "factory": "fs", "options": { "filePath": "/var/lib/weaver/control/entries.json" } },
      { "id": "platform", "factory": "fs", "options": { "filePath": "/var/lib/weaver/platform/entries.json" } },
      { "id": "tenant", "factory": "fs", "options": { "filePath": "/var/lib/weaver/tenant/entries.json" } }
    ],
    "server": { "port": 3399, "auth": { "credentialRef": "jwt", "adminRoles": ["operators"] } }
  },
  "registrations": [{
    "serviceId": "app", "environment": "production",
    "owner": { "name": "Application", "contact": "app@example.com" },
    "schema": { "type": "object", "default": {}, "additionalProperties": false, "properties": {
      "name": { "type": "string", "default": "Weaver" },
      "description": { "type": "string", "default": "Managed configuration" }
    } },
    "fragmentSlots": []
  }],
  "scopeInventory": { "version": 1, "revision": "0", "contexts": {
    "5b5b2274656e616e74222c2261636d65225d5d": {
      "scopePath": [{ "scopeId": "tenant", "value": "acme" }], "state": "retired"
    }
  } }
}
```

Context IDs are hex UTF-8 of JSON pairs `[[scopeId,value],...]`. Explicitly list every supported full combination and its prefixes. The current bounded profile preallocates physical scope stores during initialization. HTTP `POST /v1/admin/scopes/tenant` with `{"value":"acme"}` activates that prepared context; DELETE retires it without deleting data. Unallocated values refuse instead of claiming successful provisioning. Membership and registration persist in the canonical catalog/inventory and survive restart.

Set injected credentials using your secret-management system, then run:

```sh
chmod 600 /etc/weaver/seed.json /etc/weaver/initialize.json
# Supply WEAVER_CREDENTIAL_administrator and WEAVER_CREDENTIAL_jwt (at least 32 characters).
# Supply WEAVER_ADMIN_CREDENTIAL matching the administrator reference for initialization.
pnpm --filter @weaver-conf/weaver-server start initialize /etc/weaver/seed.json /etc/weaver/initialize.json
pnpm --filter @weaver-conf/weaver-server start inspect /etc/weaver/seed.json
pnpm --filter @weaver-conf/weaver-server start validate /etc/weaver/seed.json
pnpm --filter @weaver-conf/weaver-server start start /etc/weaver/seed.json
```

`inspect` is a read-only stored-state report (`configured` is not a live-readiness claim). `validate` opens the real runtime, validates every active/cold context and resolves required secrets, then closes it without binding a port. `start` binds HTTP only after validation. SIGINT/SIGTERM close the runtime and transports. `WEAVER_PORT`, repository URLs and other old environment settings do not override the generation.

## Programmatic server and transports

```ts
const credentials = { resolveCredential: (ref: string) => secrets.get(ref) };
const admin = await authenticateBootstrapAdministrator(seed, suppliedAdminCredential, credentials);
await initializeWeaver(seed, initialization, admin, { credentials });
const server = await startWeaverServer({ seed, credentials });
// Same owned config service, registry and scope manager used by REST/SSE:
server.runtime.configService;
server.runtime.schemaRegistry;
server.runtime.scopeManager;
// A hosting SCOMP transport supplies verified per-request peer context, never request JSON:
server.runtime.createScompService(getAuthenticatedPeerContext);
await server.close();
```

The SCOMP adapter shares those services; a SCOMP socket host is not silently installed. Standalone mutation admission requires configured administrator roles. Optional programmatic `secretBackend` is installed code for application secret references. Missing application secrets refuse startup; bootstrap credentials always use the separate injected resolver. The CLI does not invent a Vault backend.

## Initialization and restart activation

Initialization validates factories/options, references, scope graph, merge support, credentials and fresh namespaces before effects. It writes a code-pinned `initializing` manifest with seed/input digests through the normal control pipeline before preparing application stores. Generation, catalog and inventory writes use that same coordinator/provider authority. A final conditional update selects the generation and marks `initialized`; no ordinary traffic is admitted before all-context validation.

A failed initialization is inspectable through the seed and remains maintenance-only. Before any effects, initialization derives a deterministic installation order with services before their fragments (including nested slots), sorts independent identities deterministically, and validates every install prefix. The intent digest still binds the exact original request, including its registration order. Repeating that exact input can resume the matching intent when application namespaces are fresh or complete empty current-format stores; a permutation or changed schema/owner/identity is a changed intent and is refused. Already completed registration records must match exactly, including audit metadata, and are not replayed; ordinary fragment registration remains create-only. It cannot adopt populated stores, unrelated generations/catalog entries, unknown partial envelopes or another intent. Missing partial namespace files and crashed filesystem locks require operator maintenance/new-target recovery; they are never auto-repaired or stolen.

`server.runtime.stageInfrastructure(id, generation, expectedRevision, admin)` enters maintenance, closes SSE and validates the candidate before storing an immutable inactive generation. `activateInfrastructure` conditionally selects it and returns the runtime to `restart_required`, **not ready**. Restart is required to use new settings/order. Invalid candidates leave the last active pointer intact. This initial profile permits settings/reordering with the same provider/scope bindings; new store topology requires explicit new-target bootstrap. Planner/apply/recover executor commands belong to the next workstream and are not stubbed here.

## Supported provider profiles

- **FS:** absolute local POSIX file path, dedicated persistent directory, current envelope and lifetime ownership. No NFS or automatic stale-lock recovery.
- **Git:** existing persistent local checkout, relative data file in a dedicated subdirectory, optional credential-free HTTPS backup remote and simple branch ID. No remote authority, clone-on-start, shared checkout instances or reset/rebase adoption. Without a backup remote there are no automatic Git commits/pushes. Local fsync is durability.
- **Mongo:** seed locator `{connectionRef,database,collection,storeId}`; the injected connection and actual configured hosts determine the expected `mongo:<hosts>/<database>.<collection>` identity. Replica-set majority+j only; standalone refuses. Generation providers use `{database,collection}` plus `credentials.connection`. No transactions or legacy root-key document reader.
- **Memory:** explicit embedded control/service use only. It is not a standalone seed or durable maintenance adapter. Unsupported personal/custom merge/layer semantics refuse before effects.

## Non-destructive backup and rebootstrap

Back up the full current envelopes: application entries, canonical registrations, scope inventory, infrastructure generations, epoch/sequence, receipts and pinned recovery records. Keep secret values in the external secret system; do not use resolved public snapshots as a replacement for raw reference-bearing backups. Audit/history destinations are independent and are not relocated by bootstrap.

Old-only, mixed, missing, malformed or future formats refuse. There is no legacy reader, converter, compatibility flag or destructive reset. Preserve the old target, prepare a **new** seed and fresh namespaces, explicitly initialize/re-register, restore compatible application anchor values through validated conditional writes, validate, then switch the external seed intentionally. Copying old envelopes to a different locator is not valid adoption; restoring old epochs transparently can revive stale tokens and is unsupported. Current-format built-in upgrades remain the separate pinned planner/apply/recovery workstream.

See [removal inventory](../bootstrap-removal-inventory.md) and [authority guarantees](../provider-authority.md).
