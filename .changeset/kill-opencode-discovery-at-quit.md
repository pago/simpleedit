---
"simpleedit": patch
---

Kill in-flight OpenCode model discovery when the app quits, so a catalog fetch that has not returned yet cannot hold Electron's shutdown open.
