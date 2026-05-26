---
"simpleedit": patch
---

Tab strip and rename modal a11y polish: the outer tab is now a `<div role="tab">` instead of a `<button>` with nested `<button>`-ish spans, the ⋯ overflow + close icons are real `<button>` siblings, and `PromptModal`'s dialog div gains `tabindex="-1"` (plus an `untrack`-seeded initial value so Svelte stops warning about `state_referenced_locally`). Fixes #97.
