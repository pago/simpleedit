---
"simpleedit": patch
---

`show_panel` now rejects an element whose `visible` is not a condition json-render can evaluate, and names the element in the error, instead of handing the malformed condition to the renderer. Also fixes two renderer bugs a working typecheck surfaced: an LSP diagnostic sent as markdown no longer shows as `[object Object]`, and a Screen PRs triage model without a model id no longer labels itself `undefined`.
