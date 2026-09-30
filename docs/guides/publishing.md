# Publishing packages

Weaver uses Changesets to prepare version changes and release pull requests. The
`Publish` GitHub Actions workflow is **release-PR-only**: despite its legacy name,
it does not publish packages to npm.

## GitHub token

The workflow uses the default `GITHUB_TOKEN` for `changesets/action` to create and
update release pull requests:

- `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`

Workflow permissions:

- Contents: read/write
- Pull requests: read/write

It does not grant `id-token: write`; PR generation needs no npm OIDC credential.
Repository settings must allow GitHub Actions to create pull requests. If that
policy is disabled, release PR creation fails with:

```text
GitHub Actions is not permitted to create or approve pull requests.
```

## Workflow behavior

On pushes to `main`, the workflow:

1. installs dependencies with `pnpm install --frozen-lockfile`,
2. builds the monorepo with `pnpm run build`,
3. uses `changesets/action` with `version: pnpm changeset version` to create or
   update the release PR when non-empty changesets exist.

No `publish` input is supplied to the action. When `hasChangesets` is `true`, the
action prepares a version PR (or does nothing for empty changesets). When it is
`false`, the action returns without publishing because no publish script exists.
There is no subsequent npm publishing step in either path. Concurrency remains
scoped to the workflow and Git ref.

Reviewing release contents, merging a version PR, and authorizing npm publication
are separate decisions. A version-PR merge does not publish anything through this
workflow. Source-policy merges also require separate authorization; neither this
safety change nor approval of release contents authorizes merging the existing
stable release proposal in PR #178.

## Separate alpha publication policy

Alpha publication is not implemented or authorized by this workflow. A future,
separately reviewed and authorized publisher is tracked in `weaver-hifc`.

- The canonical prerelease version suffix and npm dist-tag are `alpha`, **not
  `latest` or `next`**.
- Before publication, validate prerelease state and every selected public package
  version against the approved alpha release plan. Use a reviewed package
  allowlist; never broadly publish the workspace or include private applications.
- The future publisher must use pnpm publication with an explicit `--tag alpha`,
  public access, and provenance. Its npm trusted-publisher/OIDC configuration must
  match that separately approved publisher, not this PR-only workflow. No
  executable manual publisher is provided here.

Installed Changesets CLI 2.30.0 can fall back to `latest` for an only-prerelease
history and rejects an explicit publish tag during active prerelease mode.
Consequently, neither bare `pnpm changeset publish` nor
`pnpm changeset publish --tag alpha` is an approved alpha publication command.

The root `release` script still builds and invokes Changesets publishing. It is a
**legacy, unapproved entrypoint for alpha**; do not run `pnpm run release` to
publish alpha packages. Replacing that entrypoint and implementing fail-closed
publication are separate work under `weaver-hifc`. Package versions, changelogs,
changesets, npm configuration, and repository settings are unchanged by this
PR-only safety prerequisite (`weaver-68oy`).
