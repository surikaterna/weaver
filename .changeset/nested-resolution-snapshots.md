---
"@weaver-conf/config-engine": minor
"@weaver-conf/weaver-server": minor
---

Add canonical immutable resolution snapshots with operation-derived nested provenance and per-path ceilings. Opaque custom merges remain supported by legacy resolution but are rejected by governed snapshots before callback execution.

Use iterative context-aware traversal and compact private provenance rather than expanding shared DAGs into leaf-path traces. The new snapshot API exposes only frozen entries/raw layers: retain the exact engine-issued object for inspection. Parsed, cloned or JSON-roundtripped data DTOs are not inspect handles and reject with VALIDATION_ERROR before field reads. Remove the unmerged expanded trace field and trace-only type/schema exports; no consumer provenance import API is provided.

Preserve reserved own data keys safely through descriptor copying, schema parsing and merging without granting reserved-path access. Inspection ignores inherited properties and validates forged snapshot descriptors without executing getters. Correct the private legacy ceiling helper to retain its original custom merge callbacks during filtering; it remains unexported.

Server inspection now returns the merged effective object rather than the last partial layer object. Composite objects with multiple surviving provider origins have no single effectiveLayer; consumers must use the contribution breakdown instead of assuming a highest-layer winner. Primitive, null and atomic array winners remain exact. Existing server state grouping, scope order and protected projection are preserved.
