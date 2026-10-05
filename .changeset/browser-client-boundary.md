---
"@weaver-conf/weaver-client": minor
---

Add an explicit browser-safe ESM/CJS/types entry at `@weaver-conf/weaver-client/browser`, reusing the existing client APIs without filesystem persistence. The Node root and its real filesystem adapter remain unchanged. Browser consumers should import the new subpath and use IndexedDB or their own persistence adapter.
