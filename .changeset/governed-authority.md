---
"@weaver-conf/config-service": minor
"@weaver-conf/config-types": minor
---

Add an optional trusted host composition argument, native authority DTO schemas,
root-local opaque capabilities, and revocable public-leaf read request ports.
Retain current identity snapshots behind one shared operation queue. Existing
one-argument public reads remain unchanged. Explicit trusted writer bindings now
enable governed public primitive/null leaf set/remove through the same root and
request ports, with schema/policy admission, required flush, and coherent snapshot
publication. Uncertain provider outcomes trigger one readback and a root-wide
write fence; they do not imply rollback or durability. Add the shared canonical
admission package subpath. Central server hosting remains separate.
