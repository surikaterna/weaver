# @weaver-conf/transport-scomp

## 0.2.0-alpha.0

### Minor Changes

- [#155](https://github.com/surikaterna/weaver/pull/155) [`4081689`](https://github.com/surikaterna/weaver/commit/4081689aaa06236e354cf62ec56ef7ccaede370f) Thanks [@spralle](https://github.com/spralle)! - Introduce canonical JSON Schema service and fragment registration contracts, address registry entries by canonical paths, and preserve schema requests directly across transport and server boundaries. Remove namespace-derived registration and its Zod-to-JSON-Schema conversion so the canonical request and response are the only registration transport contracts.

- [#172](https://github.com/surikaterna/weaver/pull/172) [`fcf5f23`](https://github.com/surikaterna/weaver/commit/fcf5f23ab9dfe601bf9b0ad1599e2cfe1da35436) Thanks [@spralle](https://github.com/spralle)! - Add exact registered-schema identity listing and on-demand detail contracts for authenticated HTTP and trusted SCOMP peers. Keep bulk fetching available as deprecated compatibility for opted-in boot validation.

- [#158](https://github.com/surikaterna/weaver/pull/158) [`c95cc74`](https://github.com/surikaterna/weaver/commit/c95cc74934cb172da7bfe04de4bcaa7c02d02b49) Thanks [@spralle](https://github.com/spralle)! - Add runtime-validated REST and SCOMP contracts for registered writes and effective validation, including authorized canonical REST routes and accurate degraded-provider health.

- [#174](https://github.com/surikaterna/weaver/pull/174) [`52f3786`](https://github.com/surikaterna/weaver/commit/52f3786b6e8ffa8e0cb2ad46ce726cb9a38b73b5) Thanks [@spralle](https://github.com/spralle)! - Add opt-in bounded-count schema identity pages with configurable server maximum and local-revision cursors without changing legacy bulk/list APIs.

### Patch Changes

- Updated dependencies [[`4081689`](https://github.com/surikaterna/weaver/commit/4081689aaa06236e354cf62ec56ef7ccaede370f), [`fcf5f23`](https://github.com/surikaterna/weaver/commit/fcf5f23ab9dfe601bf9b0ad1599e2cfe1da35436), [`efb7660`](https://github.com/surikaterna/weaver/commit/efb766065b9a95fff271984030e79dbec90e8f60), [`c95cc74`](https://github.com/surikaterna/weaver/commit/c95cc74934cb172da7bfe04de4bcaa7c02d02b49), [`33ce80b`](https://github.com/surikaterna/weaver/commit/33ce80b5f7f0405075a72e6cdc4c3b83b1163ce7), [`b894b26`](https://github.com/surikaterna/weaver/commit/b894b26bada468e3ca74ae91e8ac3459d209d2e2), [`9501058`](https://github.com/surikaterna/weaver/commit/9501058744b84db85669e73dabe54125f20b00a8), [`52f3786`](https://github.com/surikaterna/weaver/commit/52f3786b6e8ffa8e0cb2ad46ce726cb9a38b73b5)]:
  - @weaver-conf/config-types@0.2.0-alpha.0

## 0.1.2

### Patch Changes

- Dual export CJS and ESM.

- Updated dependencies []:
  - @weaver-conf/config-types@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies []:
  - @weaver-conf/config-types@0.1.1
