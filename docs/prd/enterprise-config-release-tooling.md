# Enterprise configuration release tooling

Status: **Proposed — not implemented or approved for delivery.**

Tracking: **weaver-txq8**; predecessor assessments: **weaver-10h0** (capability catalog) and **weaver-78eu** (environment visibility). Those assessments are historical research, not a current implementation audit. This PRD describes desired behavior, not available product functionality.

Related: [proposed architecture](../adr/0005-target-aware-config-releases.md), [workflow and persona benefits](../guides/config-release-workflow.md), [README](../../README.md#proposed-designs).

## Problem and persona benefits

Teams need to know what a configuration release will change **in each target**, without copying environment-owned settings or temporary testing overrides. A baseline diff alone cannot explain effective behavior when local overrides, schemas, defaults, or expiry change the result.

| Persona | User story | Intended benefit |
| --- | --- | --- |
| Dev / service owners | As a developer, I want to author portable intent once, test required effects, and understand why a target rejects it. | Reproducible releases, actionable diagnostics, less environment-specific debugging. |
| Ops / SRE | As an operator, I want a fresh target-specific plan, guarded activation, adoption evidence, and a rehearsable recovery path. | Fewer accidental configuration changes and clearer incident decisions. |
| Customers / tenant administrators | As a customer administrator, I want a redacted view of my effective configuration, permitted customization, upcoming changes, and adoption status. | Predictable service behavior and transparent control without cross-tenant exposure. |
| Security / compliance | As a reviewer, I want attributable approvals tied to exact evidence and immutable audit records. | Enforceable separation of duties and reconstructable decisions. |

## Goals and boundaries

Promote the same immutable portable artifact through Dev, Staging, and Production, with a new plan and approval decision for every target. Preserve target-owned database connection configuration, secret references, routing, and approved customizations. Make uncertainty, shadowed required changes, expiry risk, and partial adoption visible rather than reporting generic success.

**Configuration only:** no binary deployment, database migrations, schema/data migration execution, or coordination guarantee with application deployment. Database connection settings remain target-owned configuration; this does not make databases a release payload. No arbitrary behavioral-safety proof, fleet-wide transaction, automatic side-effect reversal, or promise that every consumer supports live reload. No promotion of resolved source-environment snapshots. No generic force-success bypass.

## Delivery phases and dependencies

These are proposed dependency gates, not dates or committed milestones. Accountable teams below are proposed roles; named owners and budgets require agreement.

| Phase | Deliverable and dependency gate |
| --- | --- |
| P0 — trusted visibility | Inventory/provenance, ownership/contracts, identity/tenant isolation, redaction, audit and resilience foundations. Define freshness, telemetry and retention before exposing data. Unknown inventory must remain explicit. |
| P1 — read-only planning | Depends on P0. Immutable authoring, deterministic composition, compatibility, impact reports and tests. No activation until expiry, protected paths and concurrency scenarios are demonstrated. |
| P2 — controlled activation | Depends on P1 and reviewed policy, guarded writes, durable audit, recovery rehearsal, idempotency and failure handling. Customer writes require separately authorized ownership and permissions. |
| P3 — enterprise scale | Depends on P2 safety evidence. Fleet cohorts, richer customer self-service, identity provisioning, compliance exports and scale optimization. Security, audit and resilience are not postponed to this phase. |

## Capability catalog

All acceptance statements below are **proposed testable requirements**, not achieved results. The phase identifies first delivery and later extension. Each group names the accountable role, tool surface, inputs and outputs.

| Group / accountable team | Surface, inputs → outputs | Phase | Measurable acceptance |
| --- | --- | --- | --- |
| 1. Inventory and provenance — Ops | Environment explorer; declared topology, scope/layer revisions, consumer registration and timestamps → inventory with per-leaf origin, precedence, owner and freshness. | P0 | Every known target has a revision and timestamp; every displayed effective leaf has provenance or an explicit unknown reason. An unregistered/stale consumer cannot count as healthy coverage. |
| 2. Contracts, schema and ownership — Dev service owners | Contract registry; existing JSON Schema registrations, schema environment, semantic constraints and path ownership → pinned validation contracts and ownership decisions. | P0 | Every releasable path has an owner/classification or blocks planning; incompatible schema fixtures fail using Weaver's existing JSON Schema model, not a second configuration schema system. |
| 3. Override lifecycle — Ops with tenant owners | Override manager; ordered scoped overrides, justification, owner, start/expiry and renewal policy → authorized lifecycle records and expiry projections. | P0–P1 | Every active override has an accountable owner and expiry or approved permanence; every expiry within the planning horizon is evaluated, and renewal/removal changes invalidate dependent plans. |
| 4. Immutable portable release authoring — Dev | Release builder; reviewed portable intent, contract versions, source provenance and required-change assertions → content-addressed artifact excluding source bindings and test overrides. | P1 | Same canonical inputs reproduce the digest; changing any payload input changes it. Fixtures reject target-owned paths, including protected descendants hidden in a parent replacement. |
| 5. Three-way compatibility — Dev platform | Compatibility analyzer; old/new baselines plus the same current target bindings and ordered overrides → classified findings and remediation. | P1 | All seven outcomes below are exercised; both composed configurations and expiry states are checked. A schema-valid shadowed required change does not pass. |
| 6. Target impact — Ops | Impact planner; composition, provenance, known consumers/versions and declared dependencies → redacted leaf diff, affected targets/consumers, blast radius and uncertainties. | P1 | Every effective change links to origin and affected known consumers; unresolved dependencies and unknown inventory produce indeterminate coverage, never a fabricated zero-impact report. |
| 7. Automated tests — Dev / quality engineering | Validation harness; artifacts, contracts, semantic assertions, golden target fixtures and expiry scenarios → reproducible evidence with tool/input versions. | P1 | Tests cover set/remove/default/null/array and parent-child cases, drift, expiry and cross-tenant denial; failing mandatory tests block eligibility. Tests do not claim to prove arbitrary application behavior. |
| 8. Approvals and policy — Security with Ops | Policy gate/review UI; exact plan digest, actor roles, risk and evidence → signed/attributable approval or denial with expiry. | P1–P2 | Every activation has valid target-policy authorization; changed inputs invalidate approval. Separation-of-duty fixtures reject self-approval where required. Exceptions have scope, owner, reason and expiry; no override converts blocked findings into generic success. |
| 9. Guarded configuration activation — Ops | Activation controller; approved target plan and expected revisions → durable per-target execution record and configured revision. | P2 | Wrong-route, stale-revision and concurrent-write tests perform no unauthorized write; retries with the same idempotency key do not duplicate effects. Partial completion is recorded per target; no fleet atomicity claim. |
| 10. Adoption and drift — SRE | Observation dashboard; configured revisions, consumer acknowledgements, health signals and inventory → configured/fetched/applied/healthy/unknown states and alerts. | P0 visibility; P2 gates | Each state includes evidence and observation time. Missing acknowledgements cannot imply applied; drift or a missing health window cannot imply healthy. Notifications identify affected owners without exposing secrets. |
| 11. Recovery — Ops / incident response | Recovery planner; prior release intent plus current target bindings/overrides/contracts → newly validated recovery plan and adoption report. | P1 rehearsal; P2 execution | A changed database binding is preserved during recovery; incompatible old intent blocks recovery. A drill demonstrates partial-failure handling without claiming to reverse application side effects. |
| 12. Customer portal — Customer product team | Tenant-scoped portal; entitlements, inventory, allowed paths and impact evidence → redacted status, change notices and permitted requests/customizations. | P0 read-only; P2–P3 writes | Cross-tenant/path access tests deny every unauthorized request; customers see override expiry and required remediation. Notifications and exports obey the same masking and authorization as the portal. |
| 13. Developer CLI, API and CI — Dev platform | Versioned interfaces and CI integration; identical author/plan/evidence requests → equivalent digests, findings and machine-readable status. | P1; P2 activation | UI/API/CLI/CI fixtures produce identical policy results; no automation-only bypass. Document stable error categories, authentication, request correlation and retry semantics before activation integration. |
| 14. Enterprise identity, tenant security and secrets — Security | Identity/access administration; tenant identity, roles, workload credentials, secret references and SSO/SCIM support needs → scoped authorization and lifecycle controls. | P0; P3 provisioning expansion | Cross-tenant reads/writes and revoked identities are denied; secret canaries never appear in UI, CLI, API reports, diffs, logs, audit, notifications or exports. Before enterprise onboarding, agree SSO federation, SCIM provisioning/deprovisioning and revocation latency requirements. |
| 15. Audit and compliance — Security / compliance | Append-only audit and export service; actor, artifact, plan, policy, approval, execution and observation references → immutable, access-controlled evidence with retention/legal-hold policy. | P0; P2 write evidence | Each decision/execution is reconstructable by correlation ID; tampering is detected and unauthorized deletion denied. Failure to durably record required activation evidence blocks writes; exports retain masking and tenant boundaries. |
| 16. Resilience — SRE / platform | Control-plane operations; availability budgets, load, backups and failure injections → HA/DR runbooks, restored state and bounded degraded behavior. | P0 design/test; P2 activation gate; P3 scale | Rehearse restore and dependency failure against agreed RTO/RPO; last-known-good reads have explicit age bounds and stale labels, never authorize stale writes. Quotas, backpressure and noisy-neighbor tests preserve tenant isolation and agreed service budgets. |

## Compatibility and gate policy

Compare **old release baseline / new release baseline / current target context**: compose both baselines with the **same** captured current bindings and ordered overrides. Historical source settings are not the third input. Validate shape, ownership, semantics, required-change assertions and projected override expiry. Distinguish actual currently configured drift from this controlled comparison.

| Outcome | Meaning | Proposed default gate |
| --- | --- | --- |
| compatible | All mandatory checks pass for the captured inputs and horizon. | Eligible for approval, not automatically activated. |
| advisory | Known nonblocking impact or approved optional customization; no mandatory assertion fails. | Require acknowledgement under target policy; retain warnings. |
| remediation-required | Composed candidate violates a contract, protected ownership or mandatory policy. | Block; change intent or target configuration with its owner, then replan. |
| required-change-shadowed | Override/default interaction prevents a declared required effect, even if schema-valid. | Block; remove/adjust the authorized override or revise the requirement through review, then replan. |
| future-invalid | Candidate works now but a modeled expiry state within the horizon fails. | Block until horizon risk is remediated and recomputed. |
| indeterminate | Missing/stale inventory, unknown consumer compatibility, unavailable evidence or unmodeled semantics prevents a conclusion. | Block affected activation scope; collect evidence or explicitly narrow and reapprove scope. |
| stale-plan | Any bound revision, evidence, policy, identity authorization, timing validity or target route no longer matches. | Block; refresh, replan and obtain new approval. |

Findings may coexist. Preserve every finding; the strongest applicable blocking gate wins. Expiry horizons and evidence-age limits are mandatory target-policy inputs, not unbounded safety guarantees. Changes after that horizon require observation and reassessment. There is no generic force-success control; any narrowly permitted exception must be a reviewed policy input that leaves its risk visible and produces a new plan.

## Scenario acceptance

1. **Portable promotion:** Given a release R2 with a required retry mode and Staging's temporary force-success override, author only portable intent. Across Dev, Staging and Production, R2's digest remains identical, Production's database binding remains unchanged, and the source test override is absent from the artifact. Each target gets its own evidence and approval.
2. **Local incompatibility and shadowing:** Given Production's override selecting an old retry mode, removing that mode in R2's schema yields remediation-required. If the mode remains schema-valid but contradicts R2's required assertion, the result is required-change-shadowed. Neither activation writes. An authorized remediation changes the target revision; old approval fails and a new plan is required.
3. **Expiry and semantic edges:** Fixtures exercise explicit set/remove, missing/defaulted values, null clearing, array replacement and ancestor operations crossing protected descendants. Every current and in-horizon expiry composition has an explicit result. Unsupported or ambiguous operations are indeterminate, not silently reinterpreted.
4. **Race and partial failure:** After approval, mutate a binding, override order, contract, policy or route; activation rejects the stale plan. During a multi-target operation, inject a timeout after one write; retries reconcile that target's durable record without duplicating it, while untouched/failed targets remain distinct.
5. **Observed adoption:** A consumer fetch without an apply acknowledgement displays fetched, not applied. An apply without health evidence is not healthy. Missing inventory or expired telemetry displays unknown with age and denominator uncertainty.
6. **Recovery:** Change Production's database binding after R2. A recovery plan for R1 uses that new binding and current overrides, obtains fresh validation/approval, and reports any incompatibility. No claim is made that configuration recovery undoes requests, data writes or external actions already performed.
7. **Security and outage:** Cross-tenant attempts, secret canary exports, identity revocation, audit-store loss and stale control-plane inputs are tested before activation ships. Unauthorized access is denied, required audit failure blocks writes, and bounded last-known-good reads are explicitly degraded.

## Proposed success metrics

No measurements or achieved improvements are asserted. Baselines, numeric targets and measurement windows are **TBD before the relevant phase gate**.

| Measure | Proposed accountable owner | Definition / target decision |
| --- | --- | --- |
| Planning efficiency | Dev platform | Median/p95 author-to-actionable-plan duration; baseline and P1 target TBD. |
| Target safety | Ops | Rate of configuration incidents attributable to releases and count of protected-binding leaks; P2 incident-rate target TBD, zero leaks required in acceptance fixtures. |
| Compatibility usefulness | Dev service owners | Fraction of diagnosed failures with owner/actionable remediation, plus false-positive rate; P1 targets TBD. |
| Adoption visibility | SRE | Time to known applied/healthy state and fraction of declared inventory with fresh evidence; report unknown population separately; P2 windows/targets TBD. |
| Customer confidence | Customer product | Change-notice coverage and configuration-related support volume per active tenant; P3 baseline/targets TBD. |
| Audit and recovery | Security / SRE | Evidence reconstruction completeness, restore success and measured RTO/RPO; numeric production budgets TBD before P2. |

## Open decisions and limitations

Product and customer owners must settle tenant administrator powers, environment topology and notification commitments. Dev owners must define required-change assertion vocabulary, contract/version compatibility and the operation representation without redefining existing resolution semantics. Ops must agree freshness/expiry horizons, consumer acknowledgement and health meanings, rollout windows and partial-failure policy. Security must approve identity/SSO/SCIM requirements, exception boundaries, retention, legal holds and masking rules. SRE must set HA, DR, scale and degraded-read budgets.

These are design decisions within weaver-txq8, not an implementation backlog or authorization. Schema-valid configuration can still behave badly in an application; limited inventory, imperfect telemetry and external dependencies bound every report. Binary compatibility evidence may be consumed, but Weaver does not deploy binaries or migrate databases.
