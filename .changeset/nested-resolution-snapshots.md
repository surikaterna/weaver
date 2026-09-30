---
"@weaver-conf/config-engine": minor
"@weaver-conf/weaver-server": minor
---

Add canonical immutable resolution snapshots with operation-derived nested provenance and per-path ceilings. Opaque custom merges remain supported by legacy resolution but are rejected by governed snapshots before callback execution.

Server inspection now returns the merged effective object rather than the last partial layer object. Composite objects with multiple surviving provider origins have no single effectiveLayer; consumers must use the contribution breakdown instead of assuming a highest-layer winner. Primitive, null and atomic array winners remain exact. Existing server state grouping, scope order and protected projection are preserved.
