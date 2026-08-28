---
"simpleedit": patch
---

The ✦ Agent button, ⌘T and the phone's `+` now start the same session. They had
drifted: two of them tested the remembered model for `provider === 'openai'`,
which sends every other native model to Claude, so the same configuration
started OpenCode from the sidebar and Claude from ⌘T in the same window.

Codex also never declared the model brand its descriptor owes, so "last model
used" was unwritable for a Codex session and no new-session gesture could
produce one.
