---
"@weaver-conf/weaver-server": minor
---

Add opt-in programmatic shared-authority hosting with explicit host policy and real JWT authentication, persisted canonical registry bootstrap, and registered public primitive/null GET/inspect/PUT/DELETE operations. The legacy server remains the default. Authority mode has a distinct canonical inspection/write-result wire contract and does not yet support the current SDK's list/SSE startup, live registry administration, sessions or aggregate operations; use the documented raw HTTP subset rather than switching an existing SDK deployment unchanged.

Await actual in-flight authority settlement before releasing server-owned providers, preserve known committed and unknown write outcomes, and reject Express listen callback errors instead of falsely reporting readiness on bind failure. Route CommonJS consumers to the existing CommonJS declarations. This minor includes the backward-compatible listen-error correction tracked as weaver-pfq5; no separate duplicate patch changeset is needed.
