---
"simpleedit": patch
---

Fix staging entry in Git Log never showing as selected. The `?? undefined` fallback coerced `null` (staging hash) to `undefined`, so the "Uncommitted changes" row never got the highlighted style or correct `aria-selected` attribute.
