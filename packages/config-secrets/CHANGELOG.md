# @weaver-conf/config-secrets

## 0.1.3

### Patch Changes

- [`dc99c56`](https://github.com/surikaterna/weaver/commit/dc99c56222bdd67ebe7f3409ad5057db3926a9ff) Thanks [@kennyek](https://github.com/kennyek)! - Update development types to Node.js 26.

## 0.1.2

### Patch Changes

- Dual export CJS and ESM.

- Updated dependencies []:
  - @weaver-conf/config-types@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies []:
  - @weaver-conf/config-types@0.1.1

## 0.1.0

### Minor Changes

- [`0f352bc`](https://github.com/spralle/weaver/commit/0f352bc0dbd3c7f8eda9cd5854224bc681236349) Thanks [@spralle](https://github.com/spralle)! - Initial release of the Weaver configuration library. Provides a fully generic, consumer-declarable layered configuration system with deep merge semantics, scope hierarchies, schema validation, and composable extensions for auth, policy, secrets, and sessions.

### Patch Changes

- [#102](https://github.com/spralle/weaver/pull/102) [`308bf19`](https://github.com/spralle/weaver/commit/308bf190e26c9b0586b419b74aa3bab200898de5) Thanks [@spralle](https://github.com/spralle)! - Add Result<T,E> discriminated union type for fallible operations. Adopt Result pattern in secret-resolution-service and fs-provider. Add typed TransportError events to HTTP transport via onError callback.

- Updated dependencies [[`0f352bc`](https://github.com/spralle/weaver/commit/0f352bc0dbd3c7f8eda9cd5854224bc681236349), [`c650157`](https://github.com/spralle/weaver/commit/c6501578df1f59960c2259b0e19f904a3b284b6b), [`308bf19`](https://github.com/spralle/weaver/commit/308bf190e26c9b0586b419b74aa3bab200898de5), [`af3178c`](https://github.com/spralle/weaver/commit/af3178cf65828a755d61e49f2a6ce87784124967)]:
  - @weaver-conf/config-types@0.1.0
