---
"simpleedit": patch
---

Fix three defects in the Homebrew update path: the running-instance guard now
refuses to upgrade when `pgrep` cannot answer (rather than reading its error
exits as "nothing running"), the watchdog no longer leaves an orphaned 30-minute
`sleep` behind after every upgrade, and a failed Homebrew update can be retried
from the banner instead of being stuck until the app restarts.
