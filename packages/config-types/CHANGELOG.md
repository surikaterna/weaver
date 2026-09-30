# @weaver-conf/config-types

## 0.2.0-alpha.0

### Minor Changes

- [#155](https://github.com/surikaterna/weaver/pull/155) [`4081689`](https://github.com/surikaterna/weaver/commit/4081689aaa06236e354cf62ec56ef7ccaede370f) Thanks [@spralle](https://github.com/spralle)! - Introduce canonical JSON Schema service and fragment registration contracts, address registry entries by canonical paths, and preserve schema requests directly across transport and server boundaries. Remove namespace-derived registration and its Zod-to-JSON-Schema conversion so the canonical request and response are the only registration transport contracts.

- [#172](https://github.com/surikaterna/weaver/pull/172) [`fcf5f23`](https://github.com/surikaterna/weaver/commit/fcf5f23ab9dfe601bf9b0ad1599e2cfe1da35436) Thanks [@spralle](https://github.com/spralle)! - Add exact registered-schema identity listing and on-demand detail contracts for authenticated HTTP and trusted SCOMP peers. Keep bulk fetching available as deprecated compatibility for opted-in boot validation.

- [#158](https://github.com/surikaterna/weaver/pull/158) [`c95cc74`](https://github.com/surikaterna/weaver/commit/c95cc74934cb172da7bfe04de4bcaa7c02d02b49) Thanks [@spralle](https://github.com/spralle)! - Add runtime-validated REST and SCOMP contracts for registered writes and effective validation, including authorized canonical REST routes and accurate degraded-provider health.

- [#177](https://github.com/surikaterna/weaver/pull/177) [`33ce80b`](https://github.com/surikaterna/weaver/commit/33ce80b5f7f0405075a72e6cdc4c3b83b1163ce7) Thanks [@spralle](https://github.com/spralle)! - Require registered structural declarations for public configuration mutations and expose `SCHEMA_NOT_REGISTERED`, `WRITE_UNAVAILABLE` (proven unsent), and `WRITE_OUTCOME_UNKNOWN` (dispatch or receipt uncertain) as typed errors. Existing schemaless writes must register schemas before they can succeed. Persistent schema registries now accept only the omitted or exact `_weaver.registry.schemas` key; operators using a custom key must back up, inventory and migrate its metadata offline to that protected key before upgrading. Custom keys are rejected without moving or deleting stored data.

- [#160](https://github.com/surikaterna/weaver/pull/160) [`9501058`](https://github.com/surikaterna/weaver/commit/9501058744b84db85669e73dabe54125f20b00a8) Thanks [@spralle](https://github.com/spralle)! - Add typed schema operation audit events for REST and SCOMP registration, registered writes, and effective validation, and keep internal schema registry metadata out of public configuration reads.

- [#174](https://github.com/surikaterna/weaver/pull/174) [`52f3786`](https://github.com/surikaterna/weaver/commit/52f3786b6e8ffa8e0cb2ad46ce726cb9a38b73b5) Thanks [@spralle](https://github.com/spralle)! - Add opt-in bounded-count schema identity pages with configurable server maximum and local-revision cursors without changing legacy bulk/list APIs.

### Patch Changes

- [#165](https://github.com/surikaterna/weaver/pull/165) [`efb7660`](https://github.com/surikaterna/weaver/commit/efb766065b9a95fff271984030e79dbec90e8f60) Thanks [@spralle](https://github.com/spralle)! - Parse recursive configuration schemas as identity-aware graphs and persist registered schemas with a compact deterministic graph encoding.

- [#156](https://github.com/surikaterna/weaver/pull/156) [`b894b26`](https://github.com/surikaterna/weaver/commit/b894b26bada468e3ca74ae91e8ac3459d209d2e2) Thanks [@spralle](https://github.com/spralle)! - Reject unsafe persisted paths and environments plus non-object schema roots before mutation, and expose an enforced runtime schema for lexically stable canonical path round trips.

## 0.1.2

### Patch Changes

- Dual export CJS and ESM.

## 0.1.1

### Patch Changes

- Add support for tenant layer keys

## 0.1.0

### Minor Changes

- [`0f352bc`](https://github.com/spralle/weaver/commit/0f352bc0dbd3c7f8eda9cd5854224bc681236349) Thanks [@spralle](https://github.com/spralle)! - Initial release of the Weaver configuration library. Provides a fully generic, consumer-declarable layered configuration system with deep merge semantics, scope hierarchies, schema validation, and composable extensions for auth, policy, secrets, and sessions.

- [#20](https://github.com/spralle/weaver/pull/20) [`c650157`](https://github.com/spralle/weaver/commit/c6501578df1f59960c2259b0e19f904a3b284b6b) Thanks [@spralle](https://github.com/spralle)! - Redesign: replace tenant abstraction with generic scope model, implement nested config state with deep merge semantics, add batch writes (setMany, setNamespace, PATCH /v1/config), wildcard REST routing, provider lifecycle (flush/refresh/dirty), auto-flush on writes, and SSE streaming adapter.

- [#102](https://github.com/spralle/weaver/pull/102) [`308bf19`](https://github.com/spralle/weaver/commit/308bf190e26c9b0586b419b74aa3bab200898de5) Thanks [@spralle](https://github.com/spralle)! - Add Result<T,E> discriminated union type for fallible operations. Adopt Result pattern in secret-resolution-service and fs-provider. Add typed TransportError events to HTTP transport via onError callback.

- [#6](https://github.com/spralle/weaver/pull/6) [`af3178c`](https://github.com/spralle/weaver/commit/af3178cf65828a755d61e49f2a6ce87784124967) Thanks [@spralle](https://github.com/spralle)! - Add pluggable scope resolution cache for efficient batch getForScope() calls.
  New ScopeResolutionCache interface, built-in LRU implementation via createScopeResolutionCache(),
  and opt-in scopeCache option on ConfigurationServiceOptions.
