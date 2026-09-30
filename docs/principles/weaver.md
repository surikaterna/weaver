# Weaver Project Principles

Extends the universal and TypeScript principles with weaver-specific rules.

## Principles

- **PNPM runtime**: Use `pnpm` as the package manager and script runner. Do not use `npm run` or `yarn`.
- **Turborepo orchestration**: Use `turbo` for cross-package builds, tests, and typechecks. Do not bypass Turborepo with manual per-package scripts.
- **Package boundaries**: Each package owns one clear domain. Do not introduce cross-cutting runtime dependencies that violate the existing dependency graph.
- **Dependency direction**: Dependencies flow upward from leaf packages (`config-types`) to composite packages (`weaver-server`). Never create circular or downward dependencies.
- **Zod schemas for contracts**: Every public type at a package boundary must have a corresponding Zod schema for runtime validation. Keep schemas co-located with the types they validate.
- **Node built-in test runner**: Use `node --test` for all tests. Do not add external test frameworks without team consensus.
- **Changesets required**: Every publishable package change needs a changeset. Non-publishable changes (docs, CI, tests-only) do not.
- **Greenfield pre-1 versions**: During 0.x development, breaking and additive changes use minor; backward-compatible fixes use patch. Preserve explicit breaking summaries and migration guidance. Alpha prereleases are not stable readiness; 1.0 requires a separate readiness review and explicit human approval. Let Changesets manage prerelease state, generated versions and changelogs; never reset state or discard retained changesets to force a bump.
- **Alpha publication boundary**: Future authorized public releases must use alpha, never latest/next, and exclude private apps. Changesets 2.30.0 publication is not assumed tag-safe (only-pre can select latest; active pre mode rejects publish --tag alpha). Version-policy validators are evidence-only, not authorization or an executable publisher; publication belongs to separately approved weaver-hifc.
- **Beads for tracking**: All task tracking goes through `bd`. Do not create markdown TODO lists or use external trackers.

## Weaver PR Checklist (extends universal + TypeScript)

- [ ] Package boundaries and dependency direction preserved.
- [ ] Zod schemas exist for new/changed public types.
- [ ] `pnpm run build` and `pnpm run typecheck` pass.
- [ ] Changeset included (or justified why not).
