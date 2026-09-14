# @weaver-conf/weaver-client

## 0.1.3

### Patch Changes

- [`dc99c56`](https://github.com/surikaterna/weaver/commit/dc99c56222bdd67ebe7f3409ad5057db3926a9ff) Thanks [@kennyek](https://github.com/kennyek)! - Update development types to Node.js 26.

- Updated dependencies [[`dc99c56`](https://github.com/surikaterna/weaver/commit/dc99c56222bdd67ebe7f3409ad5057db3926a9ff)]:
  - @weaver-conf/config-engine@0.1.3
  - @weaver-conf/config-runtime@0.1.3
  - @weaver-conf/config-sync@0.1.3

## 0.1.2

### Patch Changes

- Dual export CJS and ESM.

- Updated dependencies []:
  - @weaver-conf/config-runtime@0.1.2
  - @weaver-conf/config-engine@0.1.2
  - @weaver-conf/config-types@0.1.2
  - @weaver-conf/config-sync@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies []:
  - @weaver-conf/config-types@0.1.1
  - @weaver-conf/config-engine@0.1.1
  - @weaver-conf/config-runtime@0.1.1
  - @weaver-conf/config-sync@0.1.1

## 0.1.0

### Minor Changes

- [#40](https://github.com/spralle/weaver/pull/40) [`b2ff575`](https://github.com/spralle/weaver/commit/b2ff575961ce38ccfb794f16ce13f2f42b3e8e07) Thanks [@spralle](https://github.com/spralle)! - Add offline boot resilience, IndexedDB persistence, and staleness detection

- [`0f352bc`](https://github.com/spralle/weaver/commit/0f352bc0dbd3c7f8eda9cd5854224bc681236349) Thanks [@spralle](https://github.com/spralle)! - Initial release of the Weaver configuration library. Provides a fully generic, consumer-declarable layered configuration system with deep merge semantics, scope hierarchies, schema validation, and composable extensions for auth, policy, secrets, and sessions.

- [#105](https://github.com/spralle/weaver/pull/105) [`a72884d`](https://github.com/spralle/weaver/commit/a72884d9f30d7d08f698af4ba56b2d3d324f875d) Thanks [@spralle](https://github.com/spralle)! - Add deep equality utility, transport middleware hooks, HTTP retry with backoff, and offline write queue

- [#20](https://github.com/spralle/weaver/pull/20) [`c650157`](https://github.com/spralle/weaver/commit/c6501578df1f59960c2259b0e19f904a3b284b6b) Thanks [@spralle](https://github.com/spralle)! - Redesign: replace tenant abstraction with generic scope model, implement nested config state with deep merge semantics, add batch writes (setMany, setNamespace, PATCH /v1/config), wildcard REST routing, provider lifecycle (flush/refresh/dirty), auto-flush on writes, and SSE streaming adapter.

- [#102](https://github.com/spralle/weaver/pull/102) [`308bf19`](https://github.com/spralle/weaver/commit/308bf190e26c9b0586b419b74aa3bab200898de5) Thanks [@spralle](https://github.com/spralle)! - Add Result<T,E> discriminated union type for fallible operations. Adopt Result pattern in secret-resolution-service and fs-provider. Add typed TransportError events to HTTP transport via onError callback.

- [#21](https://github.com/spralle/weaver/pull/21) [`d81bb9f`](https://github.com/spralle/weaver/commit/d81bb9f73aeaa091c763ae80364610d615ad37ea) Thanks [@spralle](https://github.com/spralle)! - Wire server entry point with REST/SSE adapters, add Zod request validation, implement Git revert rollback, and build HTTP+SSE transport for weaver-client.

- [#69](https://github.com/spralle/weaver/pull/69) [`2ec292a`](https://github.com/spralle/weaver/commit/2ec292a41745cb1b9a0f639c52a25b80d0ec6bbf) Thanks [@spralle](https://github.com/spralle)! - Unified client: typed namespace accessors (defineNamespace), client-side schema validation, instance overrides, mode tracking, pendingRestart wiring, untyped namespace escape hatch, server schema registration

- [#38](https://github.com/spralle/weaver/pull/38) [`4451043`](https://github.com/spralle/weaver/commit/445104393842826747ba98aa2a2ec6f82ef2d851) Thanks [@spralle](https://github.com/spralle)! - Add sync-runtime bridge for integrating config-sync with config-runtime state container

### Patch Changes

- [#101](https://github.com/spralle/weaver/pull/101) [`6799071`](https://github.com/spralle/weaver/commit/6799071dd7fbb40c6d6247694bfa63713d8b029f) Thanks [@spralle](https://github.com/spralle)! - Add path traversal guard, regex caching, and ReDoS safety checks

- Updated dependencies [[`4451043`](https://github.com/spralle/weaver/commit/445104393842826747ba98aa2a2ec6f82ef2d851), [`4451043`](https://github.com/spralle/weaver/commit/445104393842826747ba98aa2a2ec6f82ef2d851), [`0f352bc`](https://github.com/spralle/weaver/commit/0f352bc0dbd3c7f8eda9cd5854224bc681236349), [`4207041`](https://github.com/spralle/weaver/commit/42070418fc4636aa928d3e786fe10e5c7ebd1dcd), [`a72884d`](https://github.com/spralle/weaver/commit/a72884d9f30d7d08f698af4ba56b2d3d324f875d), [`c650157`](https://github.com/spralle/weaver/commit/c6501578df1f59960c2259b0e19f904a3b284b6b), [`308bf19`](https://github.com/spralle/weaver/commit/308bf190e26c9b0586b419b74aa3bab200898de5), [`af3178c`](https://github.com/spralle/weaver/commit/af3178cf65828a755d61e49f2a6ce87784124967), [`6799071`](https://github.com/spralle/weaver/commit/6799071dd7fbb40c6d6247694bfa63713d8b029f)]:
  - @weaver-conf/config-runtime@0.1.0
  - @weaver-conf/config-sync@0.1.0
  - @weaver-conf/config-types@0.1.0
  - @weaver-conf/config-engine@0.1.0
