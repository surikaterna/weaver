# @weaver-conf/config-sessions

Time-bounded, ephemeral storage with one metadata owner and one expiration timer
per controller. This is a trusted storage/lifecycle domain, **not** an authenticated
application session manager. Supplying an actor or owning this standalone controller
does not issue any configuration-service capability.

```typescript
import { createOverrideSessionProvider } from "@weaver-conf/config-sessions";

const controller = createOverrideSessionProvider({
  layer: "incident-overrides",
  defaultDurationMs: 60_000,
  maxDurationMs: 300_000,
  onAudit(entry) { console.log(entry.action, entry.sessionId); },
});
controller.activate({ activatedBy: "trusted-host", reason: "Investigate incident" });
await controller.provider.write("app.feature.enabled", true);
// load().entries is { app: { feature: { enabled: true } } }, not a flat key map.
controller.extend(120_000); // deadline is now + duration, not old deadline + duration
controller.deactivate();
controller.dispose();
```

## Clock, lease and queued expiry

`now` defaults to `Date.now`. An optional `timer` implements only
`setTimeout(callback, milliseconds)` and `clearTimeout(handle)`; class receivers
are preserved. Tests can inject a clock and a manual timer without changing globals.
Durations must be positive integers at most 2,147,483,647 milliseconds, and no
greater than `maxDurationMs`. An optional immutable `expiresAtLimit` caps every
activation/extension deadline (the root supplies creator capability expiry). The
standalone default duration remains four hours. `cancelExpiry()` cancels the owned
wakeup without clearing entries so a host can drain accepted work before disposal;
it is not a way to extend eligibility past the deadline.

At the deadline, `isActive()` and snapshot `isActive` become false immediately.
New writes, removes and extensions reject even if the timer has not run. Invalid
or throwing clocks fail closed. Expired entries may still be present pending
serialized cleanup: eligibility and published configuration are different facts.

Without `onExpiryRequested`, the timer commits cleanup directly. With this hook,
the timer supplies `{ sessionId, expiresAt, lease }` and leaves entries unchanged.
The trusted host queues its fallback staging, then calls `commitExpiry(intent)`.
The method checks the exact lease and deadline; stale, early, replaced and repeated
intents cannot clear a current session. An early timer wake rearms only the remaining
delay. A failed expiry callback cannot grant eligibility or erase queued data.
The hook is responsible for arranging eventual cleanup; there is no retry loop.

This hook is the integration seam for a root's existing operation queue. No root
session management port or new endpoint is supplied by this package. A root must
perform its own capability/grant checks and publish fallback through its existing
publication transaction. Already accepted provider operations are not rolled back
by a later deadline.

## Storage and audit

The provider uses the existing engine's storage path codec and `deepSet`/`deepRemove`.
Bracket-protected literal dotted keys and Unicode keys remain addressable. Array
values and nested objects are detached on input, load and session snapshots.
Reserved paths and accessor-backed values reject without changing entries. Rejected
writes return a failed native `WriteResult`, not an exception implying unknown effects.
There is no persistence, required flush, external watch or recovery claim.

Audit callbacks receive activate/extend/deactivate/expire events. Throws and rejected
promises cannot interrupt cleanup or falsify a completed transition. The standalone
legacy `auditRecorded` field acknowledges only a callback that returned `undefined`
synchronously; it is false for absent, throwing or asynchronous callbacks and **does
not prove durable audit persistence**. `overridesCleared` counts top-level stored
entries, not descendants. Disposal is terminal and idempotent.

## Native contracts

The factory exports `OverrideSessionController`, `OverrideSessionProviderOptions`,
`SessionTimer`, `SessionExpiryIntent` and their native Zod schemas. Activation uses
the existing `SessionActivationRequest`/`sessionActivationRequestSchema` from
`config-types`; ignored `elevatedAuth` fields are rejected rather than treated as
authority. Controller schemas check shape only; parsing never authenticates a host.

## Migration

Flat records such as `{ "app.feature": true }` are now nested `{ app: { feature: true } }`.
Use bracket syntax for a literal dotted segment. Inactive writes no longer seed a
future session. Expired sessions cannot be extended or resurrected. Native Node
tests replace this package's prior implicit Vitest globals, retaining its lifecycle,
storage, audit, default/custom duration, actor and cleanup assertions.

## License

MIT
