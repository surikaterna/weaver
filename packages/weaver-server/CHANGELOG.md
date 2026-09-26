# @weaver-conf/weaver-server

## 1.0.0

### Major Changes

- [#155](https://github.com/surikaterna/weaver/pull/155) [`4081689`](https://github.com/surikaterna/weaver/commit/4081689aaa06236e354cf62ec56ef7ccaede370f) Thanks [@spralle](https://github.com/spralle)! - Introduce canonical JSON Schema service and fragment registration contracts, address registry entries by canonical paths, and preserve schema requests directly across transport and server boundaries. Remove namespace-derived registration and its Zod-to-JSON-Schema conversion so the canonical request and response are the only registration transport contracts.

### Minor Changes

- [#157](https://github.com/surikaterna/weaver/pull/157) [`c092133`](https://github.com/surikaterna/weaver/commit/c0921332fdb46a25e4c6395ca658b4776b3a6c40) Thanks [@spralle](https://github.com/spralle)! - Add schema validation primitives and dedicated registered-configuration write and validation APIs.

- [#163](https://github.com/surikaterna/weaver/pull/163) [`de46525`](https://github.com/surikaterna/weaver/commit/de465259b1581903ddf02e82c05192e01218c1fd) Thanks [@spralle](https://github.com/spralle)! - Support `anyOf`, `oneOf`, `allOf`, and `not` in configuration validation and registered schema patch writes.

- [#158](https://github.com/surikaterna/weaver/pull/158) [`c95cc74`](https://github.com/surikaterna/weaver/commit/c95cc74934cb172da7bfe04de4bcaa7c02d02b49) Thanks [@spralle](https://github.com/spralle)! - Add runtime-validated REST and SCOMP contracts for registered writes and effective validation, including authorized canonical REST routes and accurate degraded-provider health.

### Patch Changes

- [#167](https://github.com/surikaterna/weaver/pull/167) [`139b311`](https://github.com/surikaterna/weaver/commit/139b3113436f7b7ccaa0513563f04ac2f7e27de1) Thanks [@spralle](https://github.com/spralle)! - Safely reuse unchanged call-local schema preparation across registered patch validation stages.

- [#166](https://github.com/surikaterna/weaver/pull/166) [`a16d5a6`](https://github.com/surikaterna/weaver/commit/a16d5a62915663a361001ca1f70bb2b4fd2fccc4) Thanks [@spralle](https://github.com/spralle)! - Remove fixed composition-validation overhead from ordinary configuration checks while preserving composition and graph-safety semantics. Bump the server so its workspace dependency delivers the config-engine runtime fix to server consumers.

- [`dc99c56`](https://github.com/surikaterna/weaver/commit/dc99c56222bdd67ebe7f3409ad5057db3926a9ff) Thanks [@kennyek](https://github.com/kennyek)! - Update development types to Node.js 26.

- [#165](https://github.com/surikaterna/weaver/pull/165) [`efb7660`](https://github.com/surikaterna/weaver/commit/efb766065b9a95fff271984030e79dbec90e8f60) Thanks [@spralle](https://github.com/spralle)! - Parse recursive configuration schemas as identity-aware graphs and persist registered schemas with a compact deterministic graph encoding.

- [#156](https://github.com/surikaterna/weaver/pull/156) [`b894b26`](https://github.com/surikaterna/weaver/commit/b894b26bada468e3ca74ae91e8ac3459d209d2e2) Thanks [@spralle](https://github.com/spralle)! - Reject unsafe persisted paths and environments plus non-object schema roots before mutation, and expose an enforced runtime schema for lexically stable canonical path round trips.

- Updated dependencies [[`c092133`](https://github.com/surikaterna/weaver/commit/c0921332fdb46a25e4c6395ca658b4776b3a6c40), [`de46525`](https://github.com/surikaterna/weaver/commit/de465259b1581903ddf02e82c05192e01218c1fd), [`139b311`](https://github.com/surikaterna/weaver/commit/139b3113436f7b7ccaa0513563f04ac2f7e27de1), [`4081689`](https://github.com/surikaterna/weaver/commit/4081689aaa06236e354cf62ec56ef7ccaede370f), [`a16d5a6`](https://github.com/surikaterna/weaver/commit/a16d5a62915663a361001ca1f70bb2b4fd2fccc4), [`dc99c56`](https://github.com/surikaterna/weaver/commit/dc99c56222bdd67ebe7f3409ad5057db3926a9ff), [`efb7660`](https://github.com/surikaterna/weaver/commit/efb766065b9a95fff271984030e79dbec90e8f60), [`c95cc74`](https://github.com/surikaterna/weaver/commit/c95cc74934cb172da7bfe04de4bcaa7c02d02b49), [`b894b26`](https://github.com/surikaterna/weaver/commit/b894b26bada468e3ca74ae91e8ac3459d209d2e2)]:
  - @weaver-conf/config-engine@0.2.0
  - @weaver-conf/config-types@0.2.0
  - @weaver-conf/transport-scomp@1.0.0
  - @weaver-conf/storage-providers@0.1.3
  - @weaver-conf/config-runtime@0.1.3
  - @weaver-conf/config-auth@0.1.3

## 0.1.4

### Patch Changes

- Dual export CJS and ESM.

- Updated dependencies []:
  - @weaver-conf/storage-providers@0.1.2
  - @weaver-conf/transport-scomp@0.1.2
  - @weaver-conf/config-runtime@0.1.2
  - @weaver-conf/config-engine@0.1.2
  - @weaver-conf/config-types@0.1.2
  - @weaver-conf/config-auth@0.1.2

## 0.1.3

### Patch Changes

- Add CORS headers to /v1/events responses.

## 0.1.2

### Patch Changes

- Add support for tenant layer keys

- Updated dependencies []:
  - @weaver-conf/storage-providers@0.1.1
  - @weaver-conf/config-types@0.1.1
  - @weaver-conf/config-auth@0.1.1
  - @weaver-conf/config-engine@0.1.1
  - @weaver-conf/config-runtime@0.1.1
  - @weaver-conf/transport-scomp@0.1.1

## 0.1.1

### Patch Changes

- Fix CORS handling in weaver-server.

## 0.1.0

### Minor Changes

- [`0f352bc`](https://github.com/spralle/weaver/commit/0f352bc0dbd3c7f8eda9cd5854224bc681236349) Thanks [@spralle](https://github.com/spralle)! - Initial release of the Weaver configuration library. Provides a fully generic, consumer-declarable layered configuration system with deep merge semantics, scope hierarchies, schema validation, and composable extensions for auth, policy, secrets, and sessions.

- [#20](https://github.com/spralle/weaver/pull/20) [`c650157`](https://github.com/spralle/weaver/commit/c6501578df1f59960c2259b0e19f904a3b284b6b) Thanks [@spralle](https://github.com/spralle)! - Redesign: replace tenant abstraction with generic scope model, implement nested config state with deep merge semantics, add batch writes (setMany, setNamespace, PATCH /v1/config), wildcard REST routing, provider lifecycle (flush/refresh/dirty), auto-flush on writes, and SSE streaming adapter.

- [#21](https://github.com/spralle/weaver/pull/21) [`d81bb9f`](https://github.com/spralle/weaver/commit/d81bb9f73aeaa091c763ae80364610d615ad37ea) Thanks [@spralle](https://github.com/spralle)! - Wire server entry point with REST/SSE adapters, add Zod request validation, implement Git revert rollback, and build HTTP+SSE transport for weaver-client.

### Patch Changes

- [#39](https://github.com/spralle/weaver/pull/39) [`3c0b9df`](https://github.com/spralle/weaver/commit/3c0b9df2d4594e15c9ee872d1fe2ff38fe549bfe) Thanks [@spralle](https://github.com/spralle)! - Extract storage providers into dedicated @weaver-conf/storage-providers package (SRP)

- [#101](https://github.com/spralle/weaver/pull/101) [`6799071`](https://github.com/spralle/weaver/commit/6799071dd7fbb40c6d6247694bfa63713d8b029f) Thanks [@spralle](https://github.com/spralle)! - Add path traversal guard, regex caching, and ReDoS safety checks

- Updated dependencies [[`3c0b9df`](https://github.com/spralle/weaver/commit/3c0b9df2d4594e15c9ee872d1fe2ff38fe549bfe), [`0f352bc`](https://github.com/spralle/weaver/commit/0f352bc0dbd3c7f8eda9cd5854224bc681236349), [`4207041`](https://github.com/spralle/weaver/commit/42070418fc4636aa928d3e786fe10e5c7ebd1dcd), [`a72884d`](https://github.com/spralle/weaver/commit/a72884d9f30d7d08f698af4ba56b2d3d324f875d), [`c650157`](https://github.com/spralle/weaver/commit/c6501578df1f59960c2259b0e19f904a3b284b6b), [`308bf19`](https://github.com/spralle/weaver/commit/308bf190e26c9b0586b419b74aa3bab200898de5), [`af3178c`](https://github.com/spralle/weaver/commit/af3178cf65828a755d61e49f2a6ce87784124967), [`6799071`](https://github.com/spralle/weaver/commit/6799071dd7fbb40c6d6247694bfa63713d8b029f)]:
  - @weaver-conf/storage-providers@0.1.0
  - @weaver-conf/config-types@0.1.0
  - @weaver-conf/config-engine@0.1.0
  - @weaver-conf/config-auth@0.0.1
