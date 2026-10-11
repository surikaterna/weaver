---
"@weaver-conf/config-sessions": minor
"@weaver-conf/config-types": minor
"@weaver-conf/config-service": minor
"@weaver-conf/weaver-server": minor
---

Use lease-fenced expiry intents and an injected clock in the existing session domain.
Session storage now uses canonical nested paths, detached values, and rejects inactive
writes. Standalone activation rejects ignored elevated-auth fields and invalid durations.
Consumers of flat dotted override records must use nested data. Configure one explicit
session layer and host limits, mint explicit session permissions plus complete config
grants, then use the host controller's `forSessions` lifecycle port. Data changes use
the existing `forMutations().apply` with a session selector. Sessions are shared scoped
ephemeral contributions; expiration and revocation publish queued fallback through
the existing authority. Caller mode strings are not authority.

Remove the unwired server `createSessionManager` and its types, the deprecated
`SessionMode`/`GodModeSession` and schema aliases, and principal `session` claims.
Migrate to the native session port; no compatibility facade or network route is added.
