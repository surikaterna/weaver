# Registered schema foundations

PR #152: `weaver-xekg`, `weaver-5bgr`, `weaver-7tx7`.

## Supported registration grammar

`registeredConfigurationSchemaSchema` is the registration-specific Zod
boundary. Service/fragment requests and persisted registry hydration use it.
Registered roots are exactly objects. `oneOf`, `anyOf`, `allOf`, and `not` are
rejected recursively, including unvisited properties, pattern properties,
additional-property schemas, homogeneous items and tuples. Invalid regular
expressions, patterns rejected by the shared `isSafePattern` policy (length
over 200 or nested quantifiers), and non-JSON default values are rejected as
well. The policy lives in config-types and is reused by engine matching;
materialization and composition never execute unchecked schema patterns. The general
`configurationPropertySchemaSchema` utility remains broader; accepting a
utility schema does not authorize its registration.

## Defaults and effective values

`materializeConfigurationDefaults(schema, value)` returns an isolated clone.
It fills absent own properties only. Existing null, false, zero, empty strings
and invalid values are not replaced. Own undefined properties are not absent.
An optional property's default applies when its parent exists. An absent
parent appears only through that parent's explicit object default. Array item
defaults apply to existing elements, without expanding or reordering arrays.
Optional schema definitions **do not** need defaults.

`validateConfigurationDefaults` checks defaults recursively, including
unvisited optional branches and all applicable declared/pattern member
constraints, using materialization followed by effective
validation. Registration runs this semantic check before state or persistence
effects, and hydration repeats it. The registered schema owns a clone of its
input, including object/array defaults.

Dynamic pattern branches are checked individually and together as potentially
overlapping contracts. Default-bearing combinations must tolerate that joint
context. This is intentionally conservative: incompatible combinations can be
rejected even when their regex languages happen to be disjoint. There is no
regex-intersection solver. Compatible overlapping defaults and default-free
pattern definitions remain supported, including beneath absent optional nodes.

Defaults cannot contain objects with an exact `_weaver: "mount"` or
`_weaver: "secret-ref"` discriminant anywhere, including arrays and malformed
markers missing their other fields. Registration and hydration reject these
before effects because defaults are inserted after resolution. Unrelated
`_weaver` object values and other string discriminants remain ordinary data.
This check includes materialized default values and optional-container/item
samples, not just literal defaults. A discriminator probe also checks defaults
from dynamic member schemas that could combine with another schema declaring
`_weaver`. Scalar defaults therefore cannot synthesize a forbidden marker in
an object, array item, fragment, or composed context.

Effective validation no longer substitutes hypothetical defaults. Callers
must materialize first and validate that exact returned value. Core reads,
snapshots, registered effective checks and projected deltas do this; REST,
SCOMP, SSE and SDK consumers receive those materialized values. Physical
layers remain sparse. Reads do not persist defaults. Durable upgrade target
placement belongs to the separately tracked maintenance planner/apply work.

`materializeConfigurationDefaultsForSchemas` performs one traversal over all
governing member schemas, including child defaults beneath a parent introduced
by another schema. The server's `evaluateEffectiveCandidate` groups compiled
service roots, materializes one contextual clone, then validates that exact
clone against every governing root. Reads, projected deltas, effective removals
and registered effective checks share this helper. Conflicting defaults cannot
authorize a removal by validating a separate hypothetical object per registry.
An effective fragment check validates the fragment in that contextual object;
it never invents a fragment when its parent is absent.
The resolved candidate also has a final recursive no-marker check before any
read, effective API response, or projected value is delivered. Invalid
projections emit only the existing removal/tombstone form, never a raw marker.
Raw write preflight uses `evaluateRawEffectiveCandidate`, the same shared
materialization/validation routine without the final resolved-value assertion:
its input may still contain legitimate unresolved references. This preserves
existing reference-resolution behavior without adding a resolver or weakening
the marker-default registration/hydration checks.

## Slot composition

`composeRegisteredServiceSchema(serviceRequest, fragmentRequests)` compiles
one service schema from existing Zod-validated registration contracts. The
registry uses this same compiler before accepting changes, during hydration,
for anchor resolution, and for its read/write bindings. Future maintenance
validation can use this exported compiler rather than reconstructing rules.

A declaration adds explicit object containers to the schema when a path was
not previously described; it does not add containers to configuration data.
Existing path containers must be exactly object-typed. Contradictory scalar,
array or union containers and overlapping slot declarations are rejected.
Schema-valued parent additional properties are considered when traversing a
missing container, not silently ignored. A path overlapping parent pattern
properties is conservatively rejected with an actionable error.

Each slot's child properties come solely from its registered fragments, with
`additionalProperties: false`, even when the parent allowed arbitrary ordinary
properties. Slot-level child schemas in parent properties, pattern properties,
or schema-valued additional properties are rejected rather than discarded or
combined with a second competing fragment contract. Define those contracts
through fragment registration. Container constraints/defaults remain in force;
a slot cannot require an unregistered child. Orphan hydrated slots/fragments
are rejected. Raw registration inspection (`getSchema`/`listAll`) stays raw;
`resolveAnchor` and enforcement use the compiled service schema.

All generic leaf/ancestor/batch writes validate the composed service root.
Dedicated writes retain fragment-level preparation and pass through that
same root boundary. Partial physical layers may omit required values; effective
objects must satisfy required constraints. An absent optional fragment is not
made required merely by registration. A read within a service fails if that
service's composed effective object is invalid, even when the requested leaf
is an otherwise valid sibling.

## Integration and verification boundary

New regression harnesses use Node's test runner and execute in the server and
client Turbo test targets alongside retained legacy Vitest suites. They cover
grammar/default denial before effects, default delivery, clone isolation, cold
scopes, rogue writes, composition and registry restart. Existing oversized
core factories and the legacy runner are inherited exceptions recorded in
the PR history, not newly approved exceptions from this implementation.

The subsequent [canonical pipeline integration](validated-control-pipeline.md)
adds strict coverage, conditional all-context activation, ingestion/reload
readiness and canonical registry ownership using this evaluator. It retains the
same controller coordinator through preparation, commit and projection, and
publishes the prevalidated resolved/defaulted candidate. Scope admission uses
persisted canonical inventory, without marker fallback. Runtime read bindings are
installed once by the core and cannot be replaced by an unvalidated registry.
Maintenance orchestration remains separately owned; the integration exposes only
a fenced, target-validated full-object repair primitive.
