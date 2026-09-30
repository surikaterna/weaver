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

This PR-generation workflow does not publish. Internal manual alpha tooling is
tracked in `weaver-4av4`; admin readiness is `weaver-21mh`, and actual publication
requires separate explicit human authorization under `weaver-hifc`. Tooling
implementation, review, source merge, settings, dispatch, and publication are
different decisions. None is implied by the others.

- The canonical prerelease version suffix and npm dist-tag are `alpha`, **not
  `latest` or `next`**.
- Before publication, validate prerelease state and every selected public package
  version against the approved alpha release plan. Use a reviewed package
  allowlist; never broadly publish the workspace or include private applications.
- The future publisher must use pnpm publication with an explicit `--tag alpha`,
  public access, and provenance. Its npm trusted-publisher/OIDC configuration must
   match `publish-alpha.yml` / `npm-alpha`, not the PR-only workflow.

Installed Changesets CLI 2.30.0 can fall back to `latest` for an only-prerelease
history and rejects an explicit publish tag during active prerelease mode.
Consequently, neither bare `pnpm changeset publish` nor
`pnpm changeset publish --tag alpha` is an approved alpha publication command.

The root `pnpm run release` now refuses nonzero **before any build or publisher**.
Never run Changesets publishing, even with a tag or dry-run, to work around it.
Package versions, retained changesets, prestate, lockfile and runtime are unchanged.

## Manual publisher contract (disabled until admin verification)

The new workflow has only `workflow_dispatch`. `plan` is the default and has no
OIDC permission or publishing command, including dry-run. It installs the frozen
lockfile with Node26/pnpm11.13.0, forces root Turbo build/typecheck/lint/test,
packs explicit selected package paths, validates tar contents/manifests and records
SHA256 plus sha512 SRI. Only bounded unauthenticated registry GETs are permitted.
Local evidence and tests default to mocked registry responses; implementation
does not run any real package-status registry probe, authentication exchange or publication.

Both future dispatches must use the **same current main commit**: `source_sha`,
genuine `GITHUB_SHA`, `GITHUB_WORKFLOW_SHA`, checkout HEAD and freshly fetched
`origin/main` must all agree. The driver establishes clean attached `main`
tracking real `origin/main`, requires both-side divergence `0/0`, and keeps native
pnpm Git checks enabled. The implementation feature worktree is not a publisher
checkout. Old ancestors are not eligible. Initial PLAN must wait for a separately
audited/merged publisher-containing main; metadata base `2ab7b06` cannot dispatch
this workflow. No GitHub-context rewriting or branch/Git-check bypass is allowed.

`packages` is an explicit JSON array, not a shell expression or wildcard. The
14-name allowlist is in `scripts/alpha-publication-plan.mjs`; private apps and
unknown names are forbidden. Selection must include the entire internal runtime
closure, including optional peers, in deterministic dependency-first order.
Internal dev dependencies are checked against the full source version map without
forcing selection. Versions must be canonical `0.x.y-alpha.N`. Processed
prerelease IDs and original versions must remain present. The merged metadata
base is the immutable initialVersions/processed-ID retention baseline, not a
hardcoded future version table; no reset/exit is done.
An absent `private` flag has npm's public meaning and is normalized to a false
domain flag only for validation; packed/source manifests are never rewritten.

Every packed manifest must have exact Weaver `repository.url`, dist outputs and
safe exports/dependency specs. Publish-config overrides, lifecycle hooks, source
files, links, ambiguous tar entries and private/internal aliases are rejected.
**Current full-set source readiness is blocked:** `config-runtime` and
`storage-providers` at the metadata base lack `repository.url`, including in
actual pnpm packs. The tooling rejects them rather than injecting metadata,
repacking, excluding required closure or weakening npm identity validation.
This needs separately scoped source work (`weaver-0fy3`); valid subset/local mock proof is not
evidence that all fourteen current packages are publish-ready.

## Reviewing a PLAN and a future PUBLISH

PLAN records source/workflow SHA and tree, lock/prestate digests, observed
Node/npm/pnpm versions and executable/native-bundle SHA256, PLAN run/attempt/URL, exact ordered
package/tar hashes and registry status/tag snapshots. Its canonical JSON hash
does not circularly include its own artifact upload ID. Actions upload is
immutable; PUBLISH independently reads authenticated same-repository successful
dispatch/run metadata, artifact ID/digest/expiry, then verifies downloaded ZIP
bytes, canonical plan/hash, selection, run attempt and every tar manifest/hash.
It uses those **same bytes**, never rebuilding/repacking them.

PUBLISH inputs require `plan_run_id`, `plan_hash`, and exact confirmation:

```text
PUBLISH ALPHA <source_sha> <plan_hash>
```

The unprivileged review job shows the verified plan before the protected
`npm-alpha` job. Only that job has `id-token: write`; it executes no dependency
install, build, test or source lifecycle. Pinned actions provision the Node and
pnpm tools only. No elevated PLAN permissions, write token or npm secret exists.

YAML **does not configure protection**. The driver requires actual supported
GitHub API evidence of nonempty reviewers, self-review prevention, no admin
bypass and exactly a `main` branch deployment policy. Unknown/missing/unreadable
controls block. Repository variable `ALPHA_ADMIN_EVIDENCE` alone is not readiness:
it must match the inspected protection hash and exact workflow SHA, contain
separately approved `weaver-hifc` source/selection authorization, and redacted
admin verification for each selected package's ownership and exact npm trust
identity/direct-publish permission. Admin21mh must establish these settings and
API inspectability under separate permission; none has been inspected/configured
here. Settings/API failures must never be waived to make the job work.

Child publisher configuration has isolated empty user/global npm configuration,
HOME/XDG directories outside checkout, a fixed environment whitelist (genuine
GitHub context unchanged), no static token/tokenHelper/proxy/fallback credentials,
and disabled network retries. CI requires the direct action-provisioned pnpm
distribution, inspects/hashes its reviewed native bundle, compares tools with
PLAN, and disables Corepack network fallback. Repository credential/hook config or workspace
config outside the reviewed minimal template is refused. Native calls are only:

```text
pnpm publish <absolute verified .tgz> --tag alpha --access public --provenance --registry https://registry.npmjs.org
```

Git and readiness are rechecked after environment approval and before every
upload. All tar/status/tag snapshots are reconciled before the first upload.
Any drift requires a new PLAN/hash/approval. Existing matching immutable versions
are verified and **never retagged**, even if their alpha tag differs; conflicting
or missing integrity blocks. New uploads explicitly intend alpha only; latest
and next are checked unchanged. Visibility polling is bounded. An ambiguous
failure stops remaining packages, never blindly retries/reuploads, overwrites,
rolls back or unpublishes. The result artifact distinguishes published,
verified-existing, failed-unknown and not-attempted, including accepted uploads
whose visibility remains uncertain. A rerun requires a newly reconciled PLAN and
approval. Concurrency serializes publisher runs, **not main writers**: a mid-run
main advance can leave a partial release; no atomicity/main-freeze is promised.

## Compatibility and provenance limits

Official [pnpm publish documentation](https://pnpm.io/cli/publish) states that
pnpm11 is native, not npm delegation. Reviewed v11.13.0 source and installed
embedded distribution (Architect decision `weaver-49l0`) use libnpmpublish11.2.0.
Git checks precede tarball handling; the tarball branch then returns without pack
or lifecycle execution. OIDC is attempted before dry-run handling and may fall
back to configured credentials, hence no dry-run planning and no static config.
Noninteractive pipe I/O prevents OTP/browser fallback; native request retries
are set to zero. These semantics are source/mock evidence, not live proof.

[npm's trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/)
requires Node>=22.14/npm>=11.5.1 **when npm is the publisher**, GitHub-hosted runners,
exact repository/workflow/environment identities and direct publish permission.
Node26 meets the Node floor; upgrading npm is not a fix for native pnpm OIDC.
PLAN records the actual CI tool versions; local implementation used Node24.21.0,
pnpm11.13.0/npm11.19.0 and does not claim a Node26 hosted run.

Native signed npm provenance identifies the tar subject/digest, genuine shared
source commit and **current PUBLISH run/attempt**. It does **not authenticate the
earlier PLAN compilation**. PLAN build/gates and immutable artifact/hash binding
are supplemental auditable evidence, **not authenticated historical build
provenance**. Payload models in tests/results are explicitly expected semantics,
not observed signed attestations. Real configured trust, OIDC and signature proof
remain unproven until separately authorized execution under `weaver-hifc`.

No workflow dispatch, settings, package bootstrap or publication is authorized by
this guide or tooling review. Keep the publisher disabled while any requirement
or publication authorization remains unknown.
