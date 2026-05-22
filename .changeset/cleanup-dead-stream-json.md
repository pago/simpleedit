---
"simpleedit": patch
---

Remove dead --output-format stream-json codepath. The flag is silently ignored by Claude CLI 2.1.148 in TTY mode (see #95); session capture now uses --session-id via #102.
