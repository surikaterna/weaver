# @weaver-conf/config-registry

Browser-safe canonical schema registration and synchronous, detached reads.
This is the existing path-first server authority extracted into a pure domain
package, not the engine's legacy flat registry and not a configuration writer.
Runtime dependencies are only config-types, config-engine and Zod. Web Crypto
(`globalThis.crypto.getRandomValues`) is required; no weak entropy fallback exists.

```ts
import { createCanonicalSchemaRegistry } from "@weaver-conf/config-registry";

const registry = createCanonicalSchemaRegistry({ defaultEnvironment: "dev" });
const result = registry.register({
  serviceId: "billing",
  environment: "dev",
  owner: { name: "billing", contact: "billing@example.org" },
  schema: { type: "object", properties: { enabled: { type: "boolean" } } },
  fragmentSlots: [{ slotPath: "/plugins", accepts: "object" }],
});
if (result.success) registry.getSchema("billing", "dev");
```

Fragment registration requires an existing service slot in the exact environment.
Service updates preserve occupied slots; duplicate fragments fail. Reads retain
literal path segments and shared acyclic schema graphs without exposing live data.
`resolveAnchor` chooses the longest path-boundary match. Exact identity/detail
lookups support tuples that the legacy `listAll` projection rejects as ambiguous.
Pages retain the version-1 41-byte/55-character base64url cursor wire format,
bound to one instance and successful-registration revision.

`CanonicalSchemaRegistryReader` is an executable read capability, not a serialized
snapshot or caller-provided authority. Request/result/context/options/anchor data
schemas reuse the canonical config-types contracts. No registration metadata
grants permission to read or write configuration.

## Internal server integration

`@weaver-conf/config-registry/internal/server-adapter` is an intentional,
browser-safe **internal integration boundary**, not a root-level map API.
`createRegistryAdapter(options, parsedState?)` owns one state and identity index.
`prepare(request, context?)` evaluates, stages a candidate and prebuilds its index,
checking revision capacity before any persistence. A successful preparation exposes
a detached `candidate` for server serialization and a one-use `publish()` closure.
Only that evaluated private candidate is published. Failed persistence must not
call publish; reads and cursor revision therefore remain unchanged. Later or
repeated publication of a stale preparation fails. Parsed-state and persistence
candidate mutations cannot alias the live authority.

Binding, queues, environment fallback, persistence I/O and the private v2 graph
codec remain server-owned. Root exports contain no mutable maps, provider callbacks,
grant issuer, validator replacement or configuration-write admission facade.
The internal entropy argument exists for deterministic tests only; normal root
and server factories use genuine Web Crypto.

## Source-function map (weaver-0b81.11)

| Former server owner/functions | Shared owner |
| --- | --- |
| schema-registry-state: schemaKey, createEmptyState, cloneState, applyEvaluation, state/entry/evaluation types | registry-state.ts |
| parseRegistrationRequest, parseServiceRegistration, parseFragmentRegistration, deriveSlotMetadata, parsedValidationFailure, firstIssueMessage, errorMessage | registration-parser.ts (errorMessage inlined into catch) |
| evaluateRegistration, findRemovedSlots, hasRegisteredFragment, evaluateFragmentRegistration, schemaEntry, newSchemaResult, evaluateExistingRegistration, validationFailure | registration-evaluation.ts; validationFailure shared from registration-parser.ts |
| listSchemas, listSchemaIdentities; duplicate getSchema/list/detail/read factory bodies; getRegisteredServiceSchema, findRegisteredAnchor, registeredAnchorFromEntry, isAnchorPathMatch, normalizeAnchorLookupPath | registry-read.ts |
| schema-identity-pages: IdentityRef, compare, buildIdentityIndex | identity-index.ts |
| decode, encode, invalid | identity-cursor.ts (portable canonical base64url/Uint8Array/DataView) |
| SchemaIdentityPages constructor, publish, assertCanPublish, page | identity-pages.ts (page validation/partition decomposed) |
| transient/persistent candidate+index preparation and publication | internal/server-adapter.ts; canonical-schema-registry.ts adds synchronous root factory |
| result/context/anchor and registeredSchemaAnchorSchema | registry-contracts.ts; server re-exports |

Server wrappers retain async signatures, binding and mutation serialization.
Persistence parser/serializer algorithms and graph codec are unchanged; only state
imports now cross the intentional internal boundary. Structural operation support
and isolated packed-consumer proof belong to successor **weaver-0b81.12**.

Equivalence fixtures in `test/fixtures/frozen-outcomes.json` were captured by
executing the original evaluator and both original server factories at frozen
assembly `1857511f60b42a14506396f658d83ae771b22683`, with the ordered 18 real
requests in `requests.mjs`. Direct old/new comparisons passed before recording.
The retained SHA-256 checkpoints cover complete normalized outcomes, identities,
exact detail/anchor reads, restart/legacy projections and v2 persistence, including
separate hashes of exact JSON bytes. They are test expectations, never authority
inputs. Tests do not fetch Git history or require historical objects, so shallow
CI checkouts remain supported. Auditor should reproduce the old-source capture
against the pinned assembly when reviewing fixture provenance.

## Alpha onboarding (weaver-jtaw)

This new publishable package starts at source **0.0.0**, `private: false`, with
`publishConfig.access: public`. Its MINOR changeset accompanies a server PATCH.
This is an unpublished implementation seed, not stable readiness or permission
to publish 0.0.0. Existing alpha versions and all retained changesets are preserved.
Do not edit `pre.json`, set an alpha version manually, reset pre mode, or apply
versions in the implementation worktree.

Architect's offline Changesets CLI 2.30.0 proof (`weaver-jtaw`) used disposable
manifest-only independent and server-dependent fixtures. A later separately
authorized release-managed `pnpm changeset version` fills missing
`initialVersions["@weaver-conf/config-registry"]` with `0.0.0` and generates
`0.1.0-alpha.0`, preserving existing initial versions and processed changeset IDs.
A repeated version invocation without new changesets does not bump again. A
dependent server may advance its existing alpha train; this is not a global reset.
Source prerelease state and evidence-only publication allowlists remain unchanged.
Actual release/publication requires separate approval and release-boundary review.
## Registered public reads

`createRegisteredReadProjection(reader, snapshot, context)` composes the same
canonical registry reader with an **exact engine-issued** resolution snapshot.
The snapshot is authenticated through `inspectResolvedPath(snapshot, [])` before
any supplied snapshot fields are read. Clones and DTO-parsed copies are not
inspection handles. The context carries an environment, ordered scope tuple, and
revision; the returned interface exposes no raw snapshot or registry capability.

The interface provides `get`, `getAtLayer`, `getNamespace`, `inspect`, and `entries`.
Unknown direct paths throw `SCHEMA_NOT_REGISTERED`. Declared non-public or
sensitive paths throw `FORBIDDEN`; inspection represents denial as `redacted`
without a value field. Declared absent values are ordinary missing values.
Defaults belong to callers and must only substitute after a successful missing
read, never after catching a policy error.

Public reads require absent/public `x-weaver.visibility` and `sensitive !== true`.
Ancestor restrictions and eligible composition branches cannot be declassified
by a child. Unknown or denied aggregate children are pruned while public siblings
remain. Arrays preserve positions. Secret references and unresolved mount
references are never emitted or dereferenced. Pre-resolved aliases require source
proof from both raw and effective graphs. Each raw contributor is classified
independently, so a public override cannot expose a lower-layer reference.

Output graphs and inspection DTOs are detached and frozen. Inspection uses the
existing configuration-service discriminants and engine provenance, including
undefined winners for composite objects. Serializing a DTO does not authenticate
a reader, context, or snapshot. Legacy server reads retain their existing policy;
this API does not introduce a global registered-read gate into them.

### Structural reuse ledger

The read walker privately imports `allows`, `objectMembers`, `arrayMembers`, and
`validBranch` from the corrected structural-write witness. Their bodies are
unchanged and they are not public root exports. Read traversal is iterative and
uses the real engine branch validator; it does not invoke recursive
`schemaWriteSupport` or copy a member resolver. The provenance test reverses only
the four explicitly counted private export prefixes, then applies the retained
safety reversals and historical digest check. Original-body mutations and
missing/duplicate/unexpected export anchors remain negative cases.

An operation-local anchor routing trie captures one detached schema per canonical
anchor/environment through the supplied reader. Contexts intern structural policy,
ancestor restriction, candidate, and raw source boundaries; shared values never
grant access merely because another path allowed the same object. The registry
still owns registration and longest-anchor authority. No host grants, mutation
admission, persistence, mount evaluator, or secret backend is added here.
### Native registered-read contracts

The context and callable-shape schemas use co-located native Zod object contracts
after descriptor-first admission. `parse`/`safeParse`, input/output types and method
signatures retain their meaning; `.out` exposes the native object contract (unwrap
the readonly context first). Context identity uses the configuration-types schema,
not a duplicate validator or identity data-projection pass. Shape validation never
invokes capabilities, authenticates a reader, or turns a DTO into an issued
snapshot. Native Zod runs under standard JavaScript prototypes; executable ambient
prototype modification and Proxy reflection are not a supported sandbox boundary.
