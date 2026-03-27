---
"simpleedit": patch
---

Fix MonacoDiffEditor recreating the entire Monaco instance on every file switch or content refresh. The creation effect now uses `untrack` for content and filePath reads, so it only re-runs when the container mounts. The existing content-update effect handles all subsequent changes cheaply.
