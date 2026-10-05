---
"@weaver-conf/weaver-server": patch
"@weaver-conf/transport-scomp": patch
---

Bundle the used portions of the existing locked `@scompr/core` dependency into both ESM and CommonJS builds so synchronous CommonJS consumers no longer enter its broken external require artifact. Preserve runtime entry points, declarations and dependency versions. Include the complete upstream MIT attribution in each published package. This is a packaging correction, not authority-mode SCOMP support or a new wire protocol.
