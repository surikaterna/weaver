---
"@weaver-conf/weaver-server": patch
---

Require patched Node.js release lines (22.23.4+, 24.22.1+, or 26.12.1+ within the corresponding major) for the server's native Brotli request decoder. Deployments must upgrade their Node runtime and rebuild/restart existing images to address CVE-2026-111497.
