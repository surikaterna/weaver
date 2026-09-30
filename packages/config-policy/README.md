# @weaver-conf/config-policy

> Change control policies, ratchet validation, and emergency override tracking for Weaver configuration.

## Installation

```bash
pnpm add @weaver-conf/config-policy
```

## Overview

`@weaver-conf/config-policy` provides governance controls for configuration changes. It includes a policy engine that evaluates `changePolicy` rules (direct-allowed, staging-gate, full-pipeline, emergency-override), a validation function that audits policy assignments against security conventions, a one-way ratchet validator that prevents loosening of restrictive settings across layers, and an override tracker for managing emergency override lifecycles with follow-up deadlines.

These tools compose with `@weaver-conf/config-auth` — the policy engine accepts a `canWrite` function from the auth layer and layers additional policy checks on top.

## Usage

### Browser entry versus Node root

Browser consumers must use `@weaver-conf/config-policy/browser`, available as
ESM, CommonJS, and strict TypeScript declarations. It exports exactly
`createInMemoryOverrideTracker`, `evaluateChangePolicy`, `validateChangePolicies`,
`DEFAULT_PLUGIN_MANAGEMENT_RATCHET_RULES`, and `validateOneWayRatchet`, plus the
existing tracker, policy decision/context/violation, and ratchet types.
It does not export filesystem tracking, promotion contracts, or server APIs.
Canonical emergency override records and promotion schemas remain owned by
`@weaver-conf/config-types`.

```typescript
import {
  evaluateChangePolicy,
  createInMemoryOverrideTracker,
} from "@weaver-conf/config-policy/browser";

const decision = evaluateChangePolicy(
  { type: "string", "x-weaver": { changePolicy: "staging-gate" } },
  { userId: "ops", roles: [] },
  "app",
  () => true, // Supply your actual base write authorization here.
);
const tracker = createInMemoryOverrideTracker({ followUpDeadlineMs: 86_400_000 });
await tracker.create({
  id: "override-1", key: "app.security.maxRetries", actor: "ops@example.com",
  reason: "Incident mitigation", layer: "app", createdAt: new Date().toISOString(),
});
```

The original `@weaver-conf/config-policy` root remains Node-only and retains all
existing exports, including `createFileSystemOverrideTracker(filePath, options?)`:

```typescript
import { createFileSystemOverrideTracker } from "@weaver-conf/config-policy";
const tracker = createFileSystemOverrideTracker("./state/overrides.json");
```

The browser entry reuses the same policy logic; a promotion decision is not a
promotion executor, and in-memory records do not survive a page reload.

### Evaluating change policies

```typescript
import { evaluateChangePolicy } from "@weaver-conf/config-policy";
import { withAuth } from "@weaver-conf/config-auth";

const auth = withAuth({ /* ... */ });

const decision = evaluateChangePolicy(
  { type: "string", changePolicy: "staging-gate" },
  { roles: ["tenantAdmin"], sessionMode: undefined },
  "tenant",
  auth.canWrite,
);

// decision: { outcome: "requires-promotion", message: "Change requires staging validation..." }
```

### Policy validation

```typescript
import { validateChangePolicies } from "@weaver-conf/config-policy";

const violations = validateChangePolicies(registry.getSchemas());
// Flags: security-sensitive keys with "direct-allowed", internal visibility
// with "direct-allowed", restart-required keys with "direct-allowed"

for (const v of violations) {
  console.warn(`${v.severity}: ${v.violation} → suggest ${v.suggestedPolicy}`);
}
```

### One-way ratchet validation

```typescript
import {
  validateOneWayRatchet,
  DEFAULT_PLUGIN_MANAGEMENT_RATCHET_RULES,
} from "@weaver-conf/config-policy";

const result = validateOneWayRatchet(
  DEFAULT_PLUGIN_MANAGEMENT_RATCHET_RULES,
  [
    { layer: "core", values: { changePolicy: "full-pipeline", visibility: "admin" } },
    { layer: "tenant", values: { changePolicy: "direct-allowed", visibility: "public" } },
  ],
  { layerOrder: ["core", "tenant", "user"] },
);

result.violations;
// [{ field: "changePolicy", transition: "loosened", fromLayer: "core", toLayer: "tenant", ... }]
```

### Emergency override tracking

```typescript
import { createInMemoryOverrideTracker } from "@weaver-conf/config-policy";

const tracker = createInMemoryOverrideTracker({
  followUpDeadlineMs: 24 * 60 * 60 * 1000, // 24 hours
});

const record = await tracker.create({
  id: "override-1",
  key: "app.security.maxRetries",
  overriddenBy: "admin@example.com",
  reason: "Emergency: brute-force attack mitigation",
  createdAt: new Date().toISOString(),
  originalValue: 5,
  overrideValue: 1,
});

const overdue = await tracker.listOverdue();
await tracker.regularize("override-1", "ops@example.com");
```

## API Reference

| Export | Description |
|---|---|
| `evaluateChangePolicy(schema, context, layer, canWrite)` | Evaluate whether a change is allowed by policy |
| `validateChangePolicies(schemas)` | Audit policy assignments for security violations |
| `validateOneWayRatchet(rules, snapshots, options)` | Validate ratchet constraints across layers |
| `DEFAULT_PLUGIN_MANAGEMENT_RATCHET_RULES` | Default ratchet rules for changePolicy, visibility, maxOverrideLayer |
| `computeDeadline(createdAt, deadlineMs?)` | Compute follow-up deadline ISO string |
| `createFileSystemOverrideTracker(options)` | File system override tracker |
| `createInMemoryOverrideTracker(options?)` | In-memory override tracker (testing) |

### Types

| Type | Description |
|---|---|
| `PolicyDecision` | Outcome: allowed, requires-promotion, requires-emergency-auth, denied |
| `PolicyEvaluationContext` | Access context extended with `overrideReason` |
| `PolicyViolation` | Validation finding with severity and suggested policy |
| `RatchetRule` | Ordered or custom ratchet rule definition |
| `RatchetValidationResult` | Evaluations, violations, and blocked transitions |
| `OverrideTracker` | Interface: create, listActive, regularize, listOverdue |

## License

MIT
