# @weaver-conf/transport-scomp

## 1.0.0

### Major Changes

- [#155](https://github.com/surikaterna/weaver/pull/155) [`4081689`](https://github.com/surikaterna/weaver/commit/4081689aaa06236e354cf62ec56ef7ccaede370f) Thanks [@spralle](https://github.com/spralle)! - Introduce canonical JSON Schema service and fragment registration contracts, address registry entries by canonical paths, and preserve schema requests directly across transport and server boundaries. Remove namespace-derived registration and its Zod-to-JSON-Schema conversion so the canonical request and response are the only registration transport contracts.

### Minor Changes

- [#158](https://github.com/surikaterna/weaver/pull/158) [`c95cc74`](https://github.com/surikaterna/weaver/commit/c95cc74934cb172da7bfe04de4bcaa7c02d02b49) Thanks [@spralle](https://github.com/spralle)! - Add runtime-validated REST and SCOMP contracts for registered writes and effective validation, including authorized canonical REST routes and accurate degraded-provider health.

### Patch Changes

- Updated dependencies [[`4081689`](https://github.com/surikaterna/weaver/commit/4081689aaa06236e354cf62ec56ef7ccaede370f), [`efb7660`](https://github.com/surikaterna/weaver/commit/efb766065b9a95fff271984030e79dbec90e8f60), [`c95cc74`](https://github.com/surikaterna/weaver/commit/c95cc74934cb172da7bfe04de4bcaa7c02d02b49), [`b894b26`](https://github.com/surikaterna/weaver/commit/b894b26bada468e3ca74ae91e8ac3459d209d2e2)]:
  - @weaver-conf/config-types@0.2.0

## 0.1.2

### Patch Changes

- Dual export CJS and ESM.

- Updated dependencies []:
  - @weaver-conf/config-types@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies []:
  - @weaver-conf/config-types@0.1.1
