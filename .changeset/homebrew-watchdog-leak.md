---
"simpleedit": patch
---

A Homebrew update no longer leaves a stray half-hour `sleep` running in the background after it finishes. The upgrade helper's timeout watchdog now ends by itself once brew exits, and the helper waits for it before exiting.
