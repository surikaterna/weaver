# Testing Conventions

This monorepo uses two test file locations, each with a distinct purpose.

## `test/*.test.mjs` — Behavioral tests

Located in `packages/*/test/`. These test the **public API surface** of a package from the outside. They import only from the package's barrel export and verify observable behavior.

Use this location for:

- Integration tests exercising multiple internal modules together
- Contract tests verifying the public interface
- Any test that should survive internal refactoring

## `src/*.test.ts` — Implementation-coupled unit tests

Co-located alongside source files in `packages/*/src/`. These test **internal implementation details** that are tightly coupled to a specific module's structure.

Use this location for:

- Unit tests for private helpers or internal algorithms
- Tests that import directly from a non-exported module
- Tests that would break (and should break) when the implementation changes

## Running tests

`pnpm run test` at the repository root is the canonical, non-forced gate.
Turborepo runs at concurrency 8, while each server partition runs its assigned
files serially. Jenkins builds first in the same workspace, so this gate reuses
the successful server build instead of forcing a second DTS build.
The server manifest must assign every discovered Node and Vitest file exactly
once; missing, stale, duplicate, wrong-suite, unknown, and empty assignments
fail before a partition starts.

Run one server partition directly with, for example,
`pnpm --filter @weaver-conf/weaver-server run test:core-pipeline`. The CLI
partition alone depends on the built server executable; source-based Node and
Vitest partitions depend only on dependency-package builds. Partitioning must
not be used to skip tests, increase timeouts, or delete coverage.

## Guidance for new tests

Place new tests in `test/` by default. Only use `src/*.test.ts` when the test is genuinely coupled to internal implementation details that are not exposed through the public API.
