---
"simpleedit": patch
---

Fix missing node_modules in production builds by bundling pure-JS dependencies into the main process bundle instead of externalizing them. Only node-pty (native module) remains external.
