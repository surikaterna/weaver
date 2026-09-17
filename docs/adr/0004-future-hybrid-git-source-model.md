# ADR 0004: Future Hybrid Git Source Model for Tenant and Plugin Configuration

## Status

Historical proposal, not a supported bootstrap/storage API. The [current seed bootstrap guide](../guides/bootstrap-config-repo.md) supersedes the server.json examples below; future multi-source ideas are not an installed capability.

## Context

At the time of this proposal, Weaver's now-retired Git bootstrap path used one repository containing
`bootstrap/server.json`, and each Git-backed layer points at one JSON file. This is
enough for early platform configuration, but it does not fit plugin-heavy
deployments where an installation can have 100+ plugins, tenant-specific
overrides, and distinct ownership boundaries.

Large installations need tenant isolation and clear review ownership without
forcing every plugin and tenant change through a single file or a single review
team. The current one-file Git provider also limits discoverability: path layout
does not encode namespace ownership, plugin identity, or tenant boundaries.

## Decision

Adopt Option C as the future design direction: a hybrid source model with a
platform repository plus optional tenant repositories. Git content will be
organized by namespace-sharded `git-tree` roots, and bootstrap will be able to
declare multiple sources.

This ADR records the direction only. It does not implement `git-tree`, multiple
sources, schema-aware path routing, tenant repositories, or GitHub App token
flows.

## Repository layout examples

Platform repository:

```text
bootstrap/server.json
config/platform/core/app.json
config/platform/plugins/payments/stripe.json
config/platform/plugins/search/algolia.json
config/defaults/tenants/base.json
```

Tenant repository:

```text
tenant.json
config/tenant/acme/core/app.json
config/tenant/acme/plugins/payments/stripe.json
config/tenant/acme/plugins/search/algolia.json
```

Namespace-sharded roots keep files small and make ownership reviewable:

```text
config/platform/plugins/<plugin-id>/<namespace>.json
config/tenant/<tenant-id>/plugins/<plugin-id>/<namespace>.json
```

## Bootstrap format examples

Future platform-only bootstrap:

```json
{
  "sources": [
    {
      "id": "platform",
      "type": "git-tree",
      "repo": "git@github.com:example/weaver-platform-config.git",
      "root": "config/platform"
    }
  ]
}
```

Future hybrid bootstrap with tenant repositories:

```json
{
  "sources": [
    {
      "id": "platform",
      "type": "git-tree",
      "repo": "git@github.com:example/weaver-platform-config.git",
      "root": "config/platform"
    },
    {
      "id": "tenant-acme",
      "type": "git-tree",
      "repo": "git@github.com:acme/weaver-tenant-config.git",
      "root": "config/tenant/acme",
      "tenant": "acme"
    }
  ]
}
```

The current bootstrap format remains unchanged until that future work lands:

```json
{
  "layers": [{ "id": "platform", "provider": "git", "path": "platform.json" }]
}
```

## Resolution semantics

Future resolution will load platform sources first, then apply tenant sources
for the active tenant. Within a source, namespace-sharded files compose into the
same logical configuration tree. More specific tenant/plugin values override
platform defaults according to the existing layer precedence model.

Conflicts should be explicit: two files in the same source must not silently own
the same fully-qualified key unless a merge policy for that namespace permits it.
Schema validation should run after source composition and before values become
visible to clients.

## Auth and ownership

GitHub CODEOWNERS should define review ownership for platform, plugin, and tenant
paths. For example, platform plugin owners can review
`config/platform/plugins/<plugin-id>/`, while tenant operators review
`config/tenant/<tenant-id>/`.

Sentinel is the future policy enforcement point for cross-repository ownership,
promotion rules, emergency overrides, and schema-aware approval checks. Until
Sentinel exists, GitHub branch protection and CODEOWNERS are the expected guard
rails.

## Migration path

1. Keep supporting the current one-file Git provider and `layers` bootstrap.
2. Introduce `git-tree` as an additive provider type for namespace-sharded roots.
3. Allow bootstrap to declare `sources` while continuing to accept `layers`.
4. Migrate platform files from `platform.json` into namespace-sharded paths.
5. Add optional tenant repositories for tenants that need isolated ownership.
6. Deprecate one-file Git usage only after compatibility tooling and docs exist.

## Consequences and risks

- More repositories and sources increase operational complexity.
- Cross-source resolution needs deterministic ordering and clear conflict errors.
- Local clone management must avoid token leakage and stale source state.
- Review ownership improves, but only if CODEOWNERS and branch protection are
  maintained accurately.
- Schema-aware path routing and Sentinel policy checks become important before
  large-scale tenant/plugin adoption.

## Non-goals

- No `git-tree` implementation in this PR.
- No multi-source bootstrap implementation in this PR.
- No schema-aware path routing in this PR.
- No tenant repository implementation in this PR.
- No GitHub App token flow in this PR.
