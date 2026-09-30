# ADR 0005: Target-aware configuration releases

Status: **Proposed — not accepted or implemented**

Date: 2026-09-30

Tracking: **weaver-txq8**, building on historical assessments **weaver-10h0** and **weaver-78eu**.

Related: [PRD](../prd/enterprise-config-release-tooling.md), [workflow](../guides/config-release-workflow.md), [README](../../README.md#proposed-designs).

## Context

Configuration intent should advance between environments without carrying Staging database bindings or test overrides into Production. Target-local overrides can make a baseline change invalid, conceal a required effect, or become invalid on expiry. Approval of a source diff is therefore insufficient.

The predecessor assessments supplied the motivation, not proof of current operational readiness. This ADR does not declare existing helpers safe for release orchestration. Weaver's documented JSON Schema configuration validation remains authoritative; proposed metadata contracts must not introduce a competing configuration schema model. Generic TypeScript views are not runtime validation.

## Proposed decision

Separate immutable portable intent from captured target context, a revision-bound assessment, and guarded activation. Promote the same artifact digest, never a resolved environment snapshot. Scope is configuration only: no binaries, database migrations, or reversal of application side effects. Database connection configuration and secret references classified as environment-owned remain under the target owner's control.

### Conceptual contracts

These are design-level records, not shipped API types, wire formats, endpoints or commands. Runtime contract schemas and canonical digest encoding require later design review; this documentation adds none.

| Record | Required conceptual content | Invariant |
| --- | --- | --- |
| Release | Immutable identity/digest; portable baseline intent and explicit operations; source provenance; contract references; required-change assertions; dependency expectations; author/test evidence references. | No resolved source bindings, secrets or temporary test overrides. Any intent change creates a new artifact. |
| Target snapshot | Tenant/service/environment and authoritative route identity; active release and configured revision; current target bindings and ordered overrides with scope, ownership and expiry; schema/policy revisions; known consumer inventory; observation times and unknowns. | A consistent, versioned capture, not a portable artifact. Sensitive values remain protected; evidence uses access-controlled references/digests rather than secret disclosure. |
| Plan | Release and previous-baseline digests; snapshot revisions; composition/validator versions; target identity/route; current and projected results; leaf provenance/diff; findings; required assertions; inventory/freshness; evidence digests; policy and horizon; validity deadline. | Reproducible for exact inputs. Cannot be reused for another target, changed input or expired evidence. |
| Approval | Plan digest and exact target; policy version; reviewer identity/role and separation-of-duty evidence; scope, expiry and any narrowly permitted exception. | Approval covers the exact evidence, not a mutable release label. Recheck current authorization at activation. |
| Activation | Plan/approval references; explicit target route; expected revisions; idempotency key; actor; durable execution state and audit correlation; resulting configured revision or failure/uncertainty. | Guarded writes and per-target results; accepted request is not proof of applied or healthy consumers. |

Digest inputs include ordering, absence, operation kinds, defaults/schema versions, evidence versions and time bounds wherever they affect a decision. Canonicalization, secret-reference versioning and consistent multi-source snapshot acquisition remain open design choices; unresolved input coherence is indeterminate, not assumed safe.

### Three-way composition and validation

For captured current target context T (bindings B and ordered overrides O), compare:

- Previous intent: compose(old release baseline, **B, O**).
- Candidate intent: compose(new release baseline, **the same B, O**).
- Explain their effective diff alongside old/new baseline differences, path provenance and actual configured-state drift.

Do not compare an old historical target snapshot against a new target snapshot and attribute all differences to the release. Do not use source-environment overlays as T. Pin schema/default behavior for each baseline and expose contract-induced differences. Unavailable previous contracts or ambiguous composition block a conclusive assessment.

Validate both composed results, with old-state failures distinguished from new regressions. Validate the candidate against applicable JSON Schema, semantic and ownership policies, known consumer constraints and required-change assertions. Assertions declare required effective outcomes, not merely that an input field was edited: a valid override can still shadow mandatory intent.

Recompose at every relevant override expiry boundary within a target-policy horizon, including interacting expiries and defaults exposed by removal. Record evaluation time, horizon, evidence age and any uncovered future state. Unknown inventory, stale observations, unresolved secret versions or unsupported semantics yield indeterminate findings. A pass is bounded evidence, never universal behavioral safety.

### Operation semantics and protected paths

Planning must preserve Weaver's existing resolution semantics and distinguish intent from effective values. The [README](../../README.md#architecture) documents recursive object merge, array replacement and null clearing; this proposal does not replace them with JSON Patch or a new merge algebra.

| Case | Required planning treatment |
| --- | --- |
| Set | Record explicit set intent, layer/scope and ownership; show the resulting value and any higher-precedence shadowing. |
| Remove | Identify the specific owned contribution being removed; simulate revealed lower layers/defaults. Do not equate removal with setting null or promise global deletion. |
| Missing/default | Distinguish absent input, explicit value and schema/default-derived effect. Pin actual validator/resolver default behavior; do not assume validation inserts defaults. |
| Null | Model existing null-clearing behavior and validate its resulting effect; never silently reinterpret null as a release deletion opcode. |
| Arrays | Respect replacement semantics, not imagined element-wise merge. Report whole-array impact and protect owned nested content. |
| Parent/descendant | Check the full affected subtree on parent set/remove/replacement as well as direct path ownership. A parent operation cannot overwrite or erase a protected database binding or secret reference indirectly. |

The operation representation and exact schema/default/removal interactions need fixtures against the authoritative engine before implementation approval. Any unsupported distinction is explicit and blocks planning rather than redefining current behavior casually.

### Findings, approval and invalidation

The [PRD gate table](../prd/enterprise-config-release-tooling.md#compatibility-and-gate-policy) defines seven outcomes: **compatible**, **advisory**, **remediation-required**, **required-change-shadowed**, **future-invalid**, **indeterminate**, and **stale-plan**. Preserve concurrent findings. Only compatible or acknowledged advisory findings are eligible under default policy; all other outcomes block the affected scope.

Approvals bind the exact artifact, old baseline, target route and tenant, binding/override revisions and order, contracts/default semantics, policy, evaluator version, assertions, evidence and time horizon. Any relevant input change, expired validity or authorization revocation invalidates the plan/approval. Recompute and review; a cached favorable report is not write authority. Exceptions, where policy permits them, require a new attributable, scoped and expiring policy decision and plan. No generic force-success flag is proposed.

### Guarded activation and failure handling

At write time, authenticate/authorize the actor, verify route/tenant identity and approval, and atomically check expected revisions with the target write. A check performed only before a later unguarded write is insufficient. Where a backend cannot provide the needed concurrency guarantee, activation is unsupported until an equivalent safe mechanism is designed; do not assume a universal transaction across providers.

Durably record intent and execution with an idempotency key scoped to the target and plan; reusing a key for a different request must fail. Retries reconcile recorded outcomes rather than creating duplicate activations. If a write may have succeeded but acknowledgement or audit finalization fails, expose uncertain state, reconcile the authoritative revision and do not blindly repeat or report success. Required durable audit unavailability prevents new writes.

Fleet promotion consists of per-target guarded steps. Canary/cohort advancement may stop on failure, missing evidence or policy thresholds. Record successes, failures, pending and unknown targets separately; there is **no fleet atomicity guarantee**. Partial completion does not authorize automatic reversal of targets already changed. Notifications are tenant-scoped, masked and correlated with durable records.

### Observation and recovery

**Configured** means authoritative desired configuration was committed. **Fetched** means a consumer reports receiving that revision. **Applied** requires a defined consumer acknowledgement. **Healthy** requires fresh agreed health evidence for the observation window. **Unknown** denotes missing, stale or insufficient evidence; it is not success. Consumers may lack acknowledgement or live-reload support; the plan must expose those limitations and policy gates.

Recovery selects prior release intent and recomposes it against **current** target bindings, overrides, contracts and policies. It produces a fresh plan, approval and guarded activation; it does not restore an old fully resolved snapshot or resurrect old database endpoints/secrets. Old intent may now be incompatible, requiring a forward fix. Configuration recovery cannot undo data writes, requests, external actions or other consumer side effects.

### Security, audit and resilience invariants

Tenant/path authorization, workload identity and separation of duties apply identically across UI, API, CLI, CI and exports. SSO/SCIM federation, provisioning and revocation requirements need explicit enterprise agreement. Secrets must be masked on every surface, including findings, notifications and immutable audit exports; access to digest/evidence metadata also needs authorization.

Audit records link actors, inputs, approvals and actual outcomes with tamper detection, retention and legal-hold controls. HA/DR and restore tests must preserve revision and idempotency evidence. Last-known-good reads may continue only within declared stale bounds and must be labeled; stale reads never justify writes. Tenant quotas/backpressure and noisy-neighbor isolation are safety foundations, not only later scale optimizations.

## Alternatives considered

| Alternative | Appeal | Reason not preferred |
| --- | --- | --- |
| Copy resolved source environment | Simple snapshot movement and easy diff. | Leaks source bindings/test overrides, loses portable provenance, and overwrites target ownership. |
| Baseline-only diff | Cheap, useful author review. | Cannot detect target override incompatibility, required-change shadowing or expiry-induced failures; retain as one view, not the safety gate. |
| Mutable named release | Easy corrections under a stable label. | Approval and promotion cannot prove identical intent; permit mutable display aliases only if authority always binds immutable digests. |

## Tradeoffs and limitations

Exact input binding creates more replanning and review work when targets change frequently. Immutable artifacts and evidence increase retention/storage needs. Consistent snapshots and guarded writes may exclude backends lacking suitable primitives. Strict uncertainty gates can delay delivery but avoid false assurance; scope narrowing must be explicit and reapproved.

JSON Schema validates structure, not arbitrary behavior. Semantic assertions and tests are only as good as declared contracts and inventory. External dependencies, unknown consumers, telemetry lag and effects beyond the expiry horizon remain limitations. Health semantics, canonical encoding, operation representation, approval exceptions, freshness budgets, customer permissions and HA/DR objectives remain open decisions assigned to proposed owners in the [PRD](../prd/enterprise-config-release-tooling.md#open-decisions-and-limitations). Acceptance of this ADR and delivery authorization are separate future decisions.
