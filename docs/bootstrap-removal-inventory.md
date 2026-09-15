# Pre-release bootstrap/removal inventory

Scope: **weaver-qkmd**, **weaver-mic8**, **weaver-2q6b**, under **weaver-s62**. This records removal decisions, not a parallel task tracker.

| Removed supported surface | Current capability / evidence |
| --- | --- |
| `bootstrap/server.json`, bootstrap-loader, environment interpolation, global mutable layer factory registry | Private versioned seed; allowlisted installed factories with exact option schemas; real CLI/runtime initialization and startup tests |
| Standalone `providers`, `repoUrl`, `mongoUri`, `port`, `jwtSecret`, `controlLayer` options and old server environment schema | `startWeaverServer({seed,credentials,factories?})`; settings live in active generation; obsolete options refuse |
| Implicit default platform memory fallback | Explicit volatile embedded control/service APIs only; standalone requires durable seed/profile |
| `BootstrapConfig`, `BootstrapLayer`, `LayerProvider`, old schemas/type barrels | Exported seed, initialization, runtime-status and inspection Zod contracts |
| `createPersistentSchemaRegistry`, aggregate layer/key/environment options, serializer/parser | One `createSchemaRegistry` over canonical registration records; grammar/default/regex/hydration tests ported to canonical catalogs |
| `_weaver.schemas`, `_weaver.registry.schemas`, `_weaver.scope` storage models | `_weaver.catalog.registrations` and `_weaver.scopeInventory`; old/mixed presence refuses without interpreting/converting payloads |
| FS raw JSON reader, mtime revisions, environmentOverlayPath and legacy file watcher | Versioned envelopes, durable revisions and explicit validated reload; current nested write/read/remove and malformed-path tests retained |
| Mongo root-key/alias/descendant reader, cleanup and legacy change-stream modules | One fenced envelope per physical layer, schema-validated refusal for old documents, real Mongo authority/recovery tests |
| Environment overlay wrapper/models (`ConfigValueSource`, `MergedLayerResult`, `EnvironmentAwareStorageProvider`, `LayerValueDetail`) | Environment fixed by seed; explicit ordered static layers; existing config inspection/provenance retained |
| Empty built-in resolver stubs | Static/dynamic/ephemeral resolvers perform asynchronous provider IO; personal resolver explicitly unsupported; standalone scope stacks expand in declared order |
| Provider Git revert followed by post-effect reload | Conditional registered-anchor rollback with an explicitly installed current-format history-value reader; no built-in converter/reset/history parser |

Promotion continues through ordinary validated target writes. Audit/history sinks and client offline caches are not moved or deleted. Existing provider ownership, receipt, namespace exclusion, fail-closed corruption and scope-security regressions remain; obsolete compatibility fixtures are replaced by explicit refusal/current-format tests, not an old-reader option.

Historical ADRs retain design rationale but are explicitly labeled historical where they describe retired bootstrap/overlay APIs. They are not current supported examples. No operator data is automatically removed. The [bootstrap runbook](guides/bootstrap-config-repo.md) requires backup, explicit new targets/re-registration and validated writes; future current-format upgrades remain distinct from legacy compatibility.

Server test orchestration is split into explicit Turbo tasks: the server `test` target runs Vitest and depends on `test:node`. Both use one worker; the root `pnpm run test` still requires both suites. The separate `test:vitest`, `test:node`, and `test:bootstrap` tasks allow bounded verification without discarding assertions or increasing their timeouts.

Audit remediation preserves the removed real HTTP OPTIONS case with allowed/denied-origin preflight and actual mutation authentication/role matrices. Schema-foundation rejection matrices now explicitly run `memory` and `fs-restart` profiles; the latter persists the canonical registry to a real filesystem envelope, releases ownership, creates a new provider/control service after each case, and verifies unchanged bytes and reconstructed schemas. The inherited registry suite uses real FS fixtures for its persistence/corruption/restart cases, not ignored boolean modes. No security/default/grammar assertions were removed to reduce duplicate labels.
