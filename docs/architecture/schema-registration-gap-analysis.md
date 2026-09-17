# Schema Registration Gap Analysis

## Executive Summary

Weaver should move from key/value-oriented schema registration toward a path-anchored object schema model. Weaver is pre-1.0 and not in production, so backwards compatibility should not be a default design constraint. Contracts should make object paths, fragment slots, and validation responsibilities explicit, even when that requires removing legacy namespace and dot-key surfaces.

| Area | AS-IS | TO-BE |
|------|-------|-------|
| Addressing | APIs and docs mix `key`, `namespace`, `prefix`, and `serviceId`; `namespace` often acts like a path prefix. | Use `path` as the canonical term for a config tree location. Remove `namespace` from the target contract. `serviceId` maps to the derived root path `/<serviceId>`, so serviceId `lynx` maps to `/lynx`. |
| Schema unit | Schemas are mostly registered against fully qualified keys or service-like identifiers. | External services register object schemas at root paths derived from `serviceId`, such as `/lynx`. |
| Extension model | Plugin-oriented naming leaks into generic configuration contracts. | Use generic `fragment`; plugin is one fragment provider type. Services declare fragment slots that accept independently registered fragment schemas. |
| Identity | Registration identity and accountability are not separated; `ownerId` can imply authorization even when usage is closer to declaration source identity. | Use `owner` only for accountable contact metadata, `providerId` for declaration source identity, and authenticated `subject` for authorization. Do not include `ownerId` in the target model. |
| Writes | HTTP, SCOMP, and clients primarily expose single key/path writes, including dot-key forms. | Writes and patches may target registered objects or members below them, but each layer persists the resulting object at the registered anchor, not flattened key/value leaves. Dot-key APIs are not part of the target model. |
| Validation | Client-side validation exists, but server-side full-object validation and transport consistency are incomplete. | Primary enforcement is schema validation of write/patch inputs and effective merged objects. Write authorization enforcement is secondary/future. |
| Layering | Layer writes can behave like sparse key/value overrides, creating ambiguity for nested object schemas. | Prefer partial override objects per layer, plus completeness validation of the effective object before fetch, deploy, or runtime use. |

Recommended decision: amend the original namespace/key design into a path-first schema registration model with fragment slots. Make this a breaking cleanup by removing legacy `namespace` and dot-key APIs from the target model. If active branches need temporary continuity, keep that support only as explicitly scoped transitional adapters outside the canonical contract.

## Purpose and Terminology

This document is intended for ARB review and implementation planning. It describes the gap between current Weaver behavior and the intended schema registration model, evaluates whether the original design should be amended, and proposes implementation phases.

Terminology for new contracts:

- **`serviceId`**: Stable external service identifier that maps to a derived root config path. For example, serviceId `lynx` maps to `/lynx`.
- **`path`**: Canonical term for a config tree location, expressed as slash-separated examples in this document such as `/lynx/plugins`. Request paths may be derived; response and metadata paths must show the derived canonical value.
- **Service-relative slot path**: A slash path under the derived service root, such as `/plugins` for service `lynx`. It is not global-root-relative; Weaver resolves it to canonical path `/lynx/plugins` in metadata and responses.
- **`namespace`**: Legacy and ambiguous term. Current code often treats it as a path prefix. New contracts should remove it. Transitional adapters may translate it only when explicitly needed for active branch continuity.
- **`fragment`**: Independently registered schema unit below a service-declared extension point. A plugin is one possible fragment provider type, but the schema model should not be plugin-specific.
- **Fragment slot / extension point**: A service-declared service-relative or canonical path that accepts independently registered fragment schemas.
- **`owner`**: Accountable team/person/contact metadata for follow-up and stewardship. It is not an authorization field.
- **`providerId`**: Stable identity of the service or fragment provider that declares a schema. For service root registrations, `serviceId` can serve as the provider identity. For fragments, use the fragment provider ID.
- **`subject`**: Authenticated principal used by credentials and policy when authorizing a registration request. It is distinct from `owner` and `providerId`.

## Intended Model

Weaver stores layered nested JSON objects. A service registers an object schema at the root path derived from its `serviceId`. Other providers register fragment object schemas below slots declared by that service.

Example registration shape:

| Path | Declared by | Meaning |
|------|-------------|---------|
| `/lynx` | Service `lynx` | Root object for the Lynx service configuration. |
| `/lynx/plugins` | Service `lynx` | Fragment slot that allows independently registered plugin or non-plugin fragments. |
| `/lynx/plugins/analytics` | Fragment provider `analytics` | Object schema for the analytics fragment. |
| `/lynx/plugins/ghost.settings.panel` | Fragment provider `ghost.settings.panel` | Object schema where `ghost.settings.panel` is a literal path segment. |

The literal segment example is intentional: `/lynx/plugins/ghost.settings.panel` means the third segment is exactly `ghost.settings.panel`, not three nested segments. Current dot-path grammar and bracket notation such as `lynx.plugins[ghost.settings.panel]` should not shape the target model. Keep them only in transitional adapters if an active branch cannot move directly to slash paths.

### Object Writes and Patches

At registered paths, writes persist object values:

```json
{
  "path": "/lynx/plugins/analytics",
  "layer": "tenant:acme",
  "value": {
    "enabled": true,
    "sampleRate": 0.25
  }
}
```

The write target is the object at `/lynx/plugins/analytics`. Weaver should not require callers to flatten this into leaf writes such as `lynx.plugins.analytics.enabled` and `lynx.plugins.analytics.sampleRate`.

Client SDKs and APIs may also expose precise patches below a registered object, such as replacing `/lynx/plugins/analytics/sampleRate` or applying a property patch under `/lynx/plugins/analytics`. Those patch targets reduce clobbering between callers, but they do not change persistence shape: the layer stores the resulting object at the registered anchor. Weaver should validate the patch input against the relevant member schema, then validate the resulting layer object and effective merged object before fetch, deploy, or runtime use.

### Enforcement Priority

The near-term enforcement goal is schema validation:

1. Validate written objects at registered paths against their registered object schemas.
2. Validate effective merged objects after layer resolution, especially when per-layer overrides are partial.
3. Report schema registration conflicts and fragment-slot violations deterministically.

Write authorization enforcement is important but secondary. The model should record accountability and declaration metadata now so future policy can answer questions such as “can this caller write this path?”, but initial delivery should not block on a complete write authorization system.

## Resolved Model and Remaining Gaps

| Concern | Current behavior | Status or gap |
|---------|------------------|---------------|
| Path terminology | Current code and docs use `key`, `namespace`, `prefix`, and `serviceId` inconsistently. | Contracts do not make the config tree location explicit and stable. |
| Schema registry anchoring | The server registry derives canonical service and fragment paths from explicit path-first requests. Client registration uses the same request union; config-engine has no registration registry. | Resolved for service anchors and declared fragment slots. |
| Fragment model | Existing helper names and comments derive namespace values from plugin IDs. | The model over-specializes around plugins instead of generic fragments. |
| Server validation | Server registration validates schema declarations, but config writes are not consistently validated as full objects against registered schemas. | Invalid persisted objects can pass through server-side write paths. |
| Transport consistency | Earlier HTTP, SCOMP, and client contracts exposed different registration concepts. | Resolved by the path-first service/fragment registration contracts shared across transports. |
| Persistence shape | Some providers write flattened keys while others can persist nested object values. | Nested object schemas can mismatch provider persistence semantics. |
| Layer semantics | Sparse overrides are natural for layered config, but object schema validation requires whole-object context. | Weaver needs explicit rules for validating partial per-layer objects and effective merged objects. |

## Design Review and Recommended Amendments

The original design direction is sound in its goals: services should declare configuration contracts, clients should validate, schemas should be available server-side, and Weaver should support layered configuration. Because Weaver is pre-1.0 and not in production, the design should be amended through a breaking cleanup before implementation hardens around legacy terms.

### Identity, Approval, and Registration Lifecycle

The target model should separate accountable contact metadata, declaration identity, and credential identity:

- Keep `owner` as team/person/contact metadata for accountability and support. It is not an authentication or authorization field.
- Do not use or keep `ownerId` in the target model. The current concept behaves more like schema declaration source or replacement identity, so the term is misleading.
- Use `providerId` for the stable identity of the service or fragment provider that declares the schema. For services, the `serviceId` can be the provider identity; for fragments, use the fragment provider ID.
- Use `subject` or the authenticated principal for current or future registration authorization. It belongs to credentials, policy, request context, and audit metadata rather than accountable contact metadata.

MVP registration should favor approved bootstrap or CI/deployment registration, not open runtime self-registration:

1. A new service requests or declares its `serviceId`, `owner`, environments, object schema, and fragment slots. Weaver derives the root path as `/<serviceId>` rather than accepting an independently settable root path.
2. The ARB, platform team, or schema authority approves serviceId uniqueness, derived path boundaries, reserved path avoidance, schema validity, fragment slots, and owner/contact metadata.
3. Credentials and policy bind an authenticated `subject` to allowed `serviceId`, `providerId`, derived path, and environment operations.
4. CI/deployment performs schema registration. Weaver validates subject authorization, path invariants, schema object shape, fragment slot rules, and records audit metadata.
5. For fragments, the parent service declares the slot, then the fragment provider registers under that slot with `providerId` and `owner`. Weaver derives the fragment path, checks that the slot exists, verifies that no collision exists, validates the schema, and confirms that the subject is authorized.
6. Future runtime self-registration requires workload identity, policy enforcement, audit, revocation and rotation, schema compatibility checks, and cache invalidation.

### 1. Replace Namespace-Centric Contracts with Path-Centric Contracts

`namespace` should not be used in new public contracts. It is overloaded: sometimes it means a grouping, sometimes a dot-delimited key prefix, and sometimes a service area. `path` directly describes the config tree location and works for both service roots and fragments.

Cleanup recommendation:

- Remove `namespace` from new HTTP, SCOMP, and client contracts.
- Normalize all slot, patch, and derived target-model paths to canonical slash `path` values in registry metadata and responses.
- Remove dot-key registration and write APIs from the target model.
- Do not accept both `serviceId` and an independently settable root `path` for service registration; derive the service path from `serviceId`.
- Add transitional adapters only when a named active branch requires them, and keep those adapters out of core contract types.

### 2. Register Object Schemas, Not Leaf Property Schemas

Leaf schemas are useful inside an object schema, but the registry unit should be the object at a concrete path. This aligns registration with write and merge semantics.

For `/lynx/plugins/analytics`, the registered schema describes the object stored at that path:

```json
{
  "type": "object",
  "properties": {
    "enabled": { "type": "boolean" },
    "sampleRate": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "required": ["enabled"],
  "additionalProperties": false
}
```

This model still allows property-level UI metadata and policy metadata through nested JSON Schema fields or `x-weaver` annotations, but the registry entry remains path-anchored.

### 3. Add First-Class Fragment Slots

Services should explicitly declare which child paths accept independently registered fragments. Slot declarations use a service-relative slot path, such as `/plugins` for service `lynx`; Weaver derives the canonical slot path `/lynx/plugins`. A fragment registration is valid only if it targets a declared slot and its `providerId` maps to one literal path segment below that slot.

Example declaration shape for service `lynx` in the default environment:

```json
{
  "serviceId": "lynx",
  "environment": "default",
  "owner": {
    "name": "Lynx Platform",
    "contact": "lynx-platform@example.com"
  },
  "schema": { "type": "object" },
  "fragmentSlots": [
    {
      "slotPath": "/plugins",
      "accepts": "object"
    }
  ]
}
```

Example fragment registration in the same environment:

```json
{
  "serviceId": "lynx",
  "providerId": "ghost.settings.panel",
  "slotPath": "/plugins",
  "environment": "default",
  "owner": {
    "name": "Ghost Settings Team",
    "contact": "ghost-settings@example.com"
  },
  "schema": { "type": "object" }
}
```

The registry should reject a fragment registration when the slot does not exist or another provider has already registered the same derived fragment path.

Path invariants for persisted registration metadata and responses:

- The derived service path is `/${serviceId}`.
- Request `slotPath` is service-relative, such as `/plugins`, and resolves against service `lynx` to canonical metadata path `/lynx/plugins`.
- The derived fragment path is `${canonicalSlotPath}/${providerId}`, so provider `ghost.settings.panel` records `/lynx/plugins/ghost.settings.panel`.

Registry metadata location invariant:

- Public configuration paths under `/_weaver` are reserved for Weaver metadata and protected from normal user writes.
- The persistent schema registry currently stores its internal document at `_weaver.registry.schemas` through internal write access, not through public config mutation routes.

## Layer Validation Recommendation

Recommended approach: allow partial override objects per layer, validate each partial override against a derived partial schema, and validate completeness on the baseline or effective object for the target environment and scope before fetch, deploy, or runtime use.

This still permits schema validation on writes without requiring every layer to contain a complete base/core object. Validation is two-tiered: write and patch inputs are checked immediately against a partial or member schema for the registered anchor, catching invalid field types and unknown properties; then Weaver validates completeness of the effective object when it can construct the target environment/scope effective config, especially before fetch, deploy, or runtime use. If no defaults, base object, or effective context exists, a partial write cannot by itself prove required fields are satisfied; it can only prove the patch is schema-compatible.

Rationale:

- Layered config is most useful when higher layers override only the fields they need.
- Requiring each layer to contain a complete object would duplicate defaults across layers and make tenant/user overrides brittle.
- Required values expected to exist everywhere should be expressed as schema defaults, and values without defaults should be enforced when constructing the baseline or effective configuration for the target environment and scope.
- Validating only partial objects would miss invalid effective combinations after merge.
- Validating both the partial write and the effective object gives fast feedback for local shape errors and correctness for runtime reads.

Expected behavior:

| Write shape | Per-layer validation | Effective validation | Result |
|-------------|----------------------|----------------------|--------|
| Baseline object or schema defaults | Validate available baseline values and defaults against the schema. | Validate merged object for the target environment/scope. | Accepted when effective completeness passes. |
| Partial override object | Validate against partial form of schema: known fields, valid field types, no forbidden properties. | Validate full merged object after applying layer precedence. | Accepted when both pass. |
| Partial override that removes or nulls required data | Validate the field operation itself. | Reject if merged object violates required constraints. | Rejected with effective-object error. |
| Unknown fragment path | Reject before value validation. | Not applicable. | Rejected with registration/slot error. |

This is an explicit amendment to a simpler “complete object per layer” design. Complete per-layer objects are easier to validate but do not fit Weaver’s layered override purpose as well as sparse objects. The target model is partial per-layer overrides plus effective completeness validation before the configuration is fetched, deployed, or used at runtime.

## Implementation Proposal

### Phase 1: Canonical Path Model and Contract Cleanup

| Workstream | Deliverable | Acceptance signal |
|------------|-------------|-------------------|
| Types and schemas | Introduce path-first registration request/result types with Zod schemas at package boundaries. | New contracts use derived paths in results/metadata; target contract types do not include `namespace` or independently settable service root paths. |
| Path normalization | Add one normalization layer for canonical slash paths. | `/lynx/plugins/ghost.settings.panel` round-trips with `ghost.settings.panel` as one literal segment. |
| Contract removal | Remove or replace namespace and dot-key registration/write APIs in HTTP, SCOMP, and clients. | New examples and public target-model APIs use slash `path` only. |
| Transitional adapters | Add scoped adapters only for named active branches that cannot switch immediately. | Any adapter normalizes to `path` before core logic and is not required for the target model. |

### Phase 2: Path-Anchored Schema Registry

| Workstream | Deliverable | Acceptance signal |
|------------|-------------|-------------------|
| Registry storage | Store registrations by environment and canonical path. | `getSchema('/lynx/plugins/analytics')` resolves the fragment object schema for that path. |
| Fragment slots | Store service-declared fragment slots and validate fragment registrations against them. | Unknown slot and duplicate derived fragment path registrations are rejected. |
| Metadata | Retain derived service path, canonical slot path, derived fragment path, `owner`, and `providerId`; keep authenticated `subject` in operation context and audit events rather than schema documents. | Registry can report declaring service, provider, slot path, fragment path, environment, and owner/contact while audit records capture the acting subject. |

### Phase 3: Object Write and Validation Pipeline

| Workstream | Deliverable | Acceptance signal |
|------------|-------------|-------------------|
| Object writes and patches | Add or amend write commands so a registered path accepts an object value and optional member/property patches below that object. | Writing or patching `/lynx/plugins/analytics` persists the resulting layer object at that registered anchor. |
| Partial layer validation | Validate sparse layer objects and patch inputs against a derived partial/member schema. | Invalid field types and unknown properties are rejected at write/patch time. |
| Effective validation | Validate merged effective objects after layer resolution. | Required fields and cross-field constraints are enforced on baseline/effective config before fetch, deploy, or runtime use. |
| Error reporting | Return path-aware validation errors. | Errors identify the registered path and nested object member path. |

### Phase 4: Provider Alignment and Migration

| Workstream | Deliverable | Acceptance signal |
|------------|-------------|-------------------|
| Persistence providers | Align filesystem, Git, MongoDB, memory, and session providers on nested object persistence for registered paths. | Providers no longer disagree on whether object writes are flattened or nested. Git appears closer to the intended nested behavior; MongoDB is a known current risk to verify and migrate. |
| Existing key writes | Remove flattened leaf-record behavior below registered objects unless a scoped adapter is approved. | Target-model callers use object writes or specific patches under registered paths. |
| Client APIs | Replace namespace helpers with path-first APIs. | Examples use `path` and `fragment`; namespace helpers are absent from the target model. |

### Phase 5: Future Authorization Enforcement

| Workstream | Deliverable | Acceptance signal |
|------------|-------------|-------------------|
| Authorization policy | Enforce which authenticated subject may register and write specific service or fragment provider paths. | Unauthorized registration/write attempts are rejected. |
| Delegation | Allow services to delegate fragment slots without transferring root control. | Providers can write only their fragment path unless policy grants more. |

## Proposed Contract Shape

Illustrative TypeScript shape for discussion, not a final API commitment:

```typescript
interface ServiceSchemaRegistrationRequest {
  readonly serviceId: string;
  readonly environment: string;
  readonly owner: RegistrationOwner;
  readonly schema: unknown;
  readonly fragmentSlots: readonly FragmentSlotDeclaration[];
}

interface RegistrationOwner {
  readonly name: string;
  readonly contact: string;
}

interface FragmentSlotDeclaration {
  readonly slotPath: string;
  readonly accepts: "object";
}

interface FragmentSchemaRegistrationRequest {
  readonly serviceId: string;
  readonly providerId: string;
  readonly slotPath: string;
  readonly environment: string;
  readonly owner: RegistrationOwner;
  readonly schema: unknown;
}

interface RegistrationMetadata {
  readonly serviceId: string;
  readonly servicePath: string;
  readonly canonicalSlotPath?: string;
  readonly providerId?: string;
  readonly fragmentPath?: string;
  readonly environment: string;
}

interface RegistrationRequestContext {
  readonly subject: string;
}
```

Request contracts derive paths instead of accepting independently settable `path` fields. `slotPath` in a request is a service-relative slot path such as `/plugins`; metadata records canonical paths. Invariants: `servicePath` is `/${serviceId}`, `canonicalSlotPath` is resolved under that service path, and `fragmentPath` is `${canonicalSlotPath}/${providerId}`.

The package-boundary implementation should replace `unknown` with validated JSON Schema types and corresponding Zod schemas. `subject` is shown as request context because authorization identity should come from credentials and policy, not from the schema document. `ownerId` is intentionally absent from the target contract.

## Open Decisions for ARB

| Decision | Recommendation |
|----------|----------------|
| Canonical external path syntax | Use slash paths in new contracts. Keep dot/bracket parsing only in explicitly scoped transitional adapters, if any. |
| Fragment identifier character rules | Permit dots inside one literal path segment so `ghost.settings.panel` is valid below `/lynx/plugins`. |
| Leaf write compatibility | Do not include flattened leaf writes in the target model. Specific patches under a registered object are acceptable when they validate the patch and persist the resulting object at the registered anchor. |
| Schema evolution policy | Treat the pre-1.0 move to path-anchored object schemas as an intentional breaking cleanup. Define post-cleanup evolution checks against path-anchored object schemas. |
| Authorization enforcement timing | Use approved bootstrap/CI registration for MVP. Defer open runtime self-registration until workload identity, policy, audit, revocation, compatibility checks, and cache invalidation are designed. |

## Conclusion

Weaver should amend the original schema registration design before expanding implementation. The path-first object schema model is a better fit for layered nested JSON storage, fragment extension points, and server-side validation. Since Weaver is pre-1.0 and not in production, the recommended path is a breaking cleanup: remove `namespace` and dot-key APIs from the target model, derive service paths from `serviceId`, derive fragment paths from slots and `providerId`, and use `path` and `fragment` consistently. Transitional adapters are optional implementation scaffolding for active branches, not part of the target contract.
