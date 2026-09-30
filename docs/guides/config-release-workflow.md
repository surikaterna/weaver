# Proposed configuration release workflow

**Design walkthrough, not an operational runbook.** These capabilities are proposed, not implemented or accepted. There are no executable release commands in this guide.

Tracking: **weaver-txq8**; historical predecessors: **weaver-10h0** and **weaver-78eu**. See the [PRD and capability catalog](../prd/enterprise-config-release-tooling.md) and [proposed ADR 0005](../adr/0005-target-aware-config-releases.md). Historical assessments do not establish current product readiness.

## What Dev, Ops and Customers gain

| Audience | Proposed daily workflow | Intended benefit |
| --- | --- | --- |
| Dev | Author portable intent, declare required outcomes, run the same assessment in review/CLI/API/CI, resolve owner-specific diagnostics. | One artifact across environments; less guesswork about why a valid change has no effect. |
| Ops | Inspect fresh target evidence, approve exact plans, activate with concurrency guards, watch adoption, rehearse recovery. | Protect environment settings, bound rollout risk, and distinguish committed configuration from actual consumer health. |
| Customers | Inspect tenant-safe configuration/provenance, see upcoming impacts and expiry notices, request or make permitted customizations. | Transparent changes and control over owned settings without seeing another tenant's data or secrets. |

All surfaces use the same authorization, masking and policy rules. Customer self-service does not grant ownership over platform-protected paths. Identity/SSO/SCIM needs, immutable audit, notifications and availability requirements are part of the proposal from the beginning, not evidence that those features already ship.

## End-to-end sequence

1. **Inspect.** Ops and Dev inspect target inventory, owners, effective values, leaf provenance, active overrides and freshness. Customers see only their authorized scope. Unknown inventory and stale consumer evidence are labeled, not counted as healthy.
2. **Author.** Dev creates immutable portable release intent with pinned contracts, provenance, tests and required-change assertions. Exclude environment bindings, secret values and source test overrides. A change to intent creates a different artifact digest.
3. **Target compose.** For each intended target, capture current bindings and ordered overrides. Compose both old and new release baselines with that same captured context. Production's context is not Staging's resolved configuration.
4. **Assess.** Produce an effective diff, provenance, blast radius, schema/semantic results, required-change checks and expiry projections within a declared horizon. Include unknown consumers/dependencies and evidence ages. Existing JSON Schema validation remains the configuration contract model.
5. **Remediate.** Route incompatible or shadowing overrides to their owner. Review authorized removal, adjustment or renewal; do not silently discard customer settings. Any changed input requires a fresh plan, including changes that appear to improve safety.
6. **Approve.** Required reviewers authorize the exact target, artifact, revisions, policy and evidence digest for a bounded time. A changed binding, override order, contract, policy, route or evidence invalidates approval. No generic force-success option changes a blocked finding into success.
7. **Promote.** Advance the **same artifact** through Dev → Staging → Production, with independent target composition, plan and approval at every step. Activation rechecks authorization and target routing and uses guarded expected-revision writes. Canary/cohort steps have per-target results, not fleet atomicity.
8. **Observe.** Track configured, fetched, applied and healthy evidence by consumer and time. Report unknown, drift, partial failure and expiry risk. Notify authorized owners/customers without leaking sensitive values. Stop further rollout when policy evidence is absent or failing.
9. **Recover.** Select earlier portable intent, recompose against current target settings and obtain fresh approval. Retain current database bindings and overrides; report incompatibility rather than replaying an old resolved snapshot. Recovery does not reverse application side effects.

## Worked example: preserve the database, expose a shadowed change

The following labels and values are illustrative requirements, not runnable configuration or a released API.

| Input | Dev | Staging | Production |
| --- | --- | --- | --- |
| Target-owned database binding | Dev database reference | Staging database reference | Production database reference |
| Local override | None in this example | Temporary test `forceSuccess = true` | Retry mode pinned to `legacy` |
| Portable R1 baseline | Retry mode `legacy` | Same R1 intent | Same R1 intent |
| Portable R2 intent | Retry mode `bounded`; required assertion: effective mode must be `bounded` | Same R2 digest | Same R2 digest |

Dev authors R2 without any database binding or Staging force-success setting. Target policy must explicitly permit Staging's temporary test override for a test-scoped plan; its expiry and distortion of test evidence remain visible. It is excluded from portable intent, and force-success-derived evidence cannot establish normal production behavior. Production composition uses only Production's current bindings and overrides.

The Production comparison composes R1 and R2 with the same Production database reference and `legacy` override. The database stays unchanged. Two contract variants demonstrate why a schema-only check is insufficient:

- If R2 removes `legacy` from allowed modes, the resulting Production candidate is **remediation-required** because its local override is incompatible.
- If `legacy` remains schema-valid, that override still defeats the required `bounded` assertion: **required-change-shadowed**. An empty effective mode diff is not proof of a safe or completed release.

The Production override owner authorizes removing or changing the pin. This changes the target revision and makes the old plan **stale-plan**, even if it had an approval. Replanning checks revealed defaults, null/remove semantics, parent/descendant protections and relevant expiry states. Only fresh passing evidence permits approval and guarded activation. At no point is the Production database replaced by Staging's database, nor is Staging's force-success override promoted.

If an override expires tomorrow and exposes an invalid candidate within the required horizon, report **future-invalid** and block. If consumer inventory or snapshot consistency is unknown, report **indeterminate** and block affected scope. A **compatible** result is merely eligible for approval; an **advisory** requires acknowledgement under policy. See the [full gate table](../prd/enterprise-config-release-tooling.md#compatibility-and-gate-policy).

## What the status means

| State | Evidence required | What it does not prove |
| --- | --- | --- |
| Configured | Authoritative target revision committed. | That any consumer has fetched it. |
| Fetched | Identified consumer reports receiving that revision. | That the consumer applied it. |
| Applied | Consumer acknowledgement under an agreed apply contract. | That the consumer is healthy or all peers applied it. |
| Healthy | Fresh agreed health signals over the required observation window. | Universal behavioral correctness or absence of later failures. |
| Unknown | Missing, stale or insufficient evidence, with last observation time where known. | Success; unknown consumers must not disappear from the denominator silently. |

These are evidence distinctions, not necessarily one universal consumer state machine. Consumers without acknowledgement or live-reload support need explicit limitations and policy treatment.

## Failures and recovery in practice

A target changed after approval must reject activation rather than overwrite concurrent work. A timeout after a possible write is uncertain: reconcile the authoritative revision and durable idempotency record before retrying. A repeated identical request must not duplicate activation; the same idempotency key with different intent must fail.

If Dev and Staging succeed but Production fails, report those separate outcomes and stop according to policy. There is no all-environment transaction or automatic rollback promise. Audit must preserve actors, plans, approvals and actual outcomes; mandatory audit failure prevents new writes. Last-known-good reads during an outage are allowed only within agreed age bounds, clearly labeled stale, and never authorize activation.

To recover R1 after R2, Ops plans R1 against **today's** Production database binding, ordered overrides, contracts and policy. A database reference changed since R2 stays current. If old intent now violates a contract, recovery blocks and a forward fix may be necessary. Even a healthy recovered configuration cannot undo already sent requests, database writes or external actions. Weaver's proposal includes neither binary rollout nor database migrations.

## Decisions before use

This workflow needs agreed target topology, customer permissions, ownership, assertion semantics, freshness/expiry horizons, approval policy, consumer acknowledgement/health contracts and HA/DR budgets. Numeric success targets remain proposed/TBD with owners in the [PRD metrics](../prd/enterprise-config-release-tooling.md#proposed-success-metrics). The four delivery phases are visibility → read-only planning → guarded activation → enterprise scale, with security, audit and resilience prerequisites in the first phase. None of this guide authorizes production use.
