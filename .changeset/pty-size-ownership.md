---
"simpleedit": patch
---

Stop two windows on the same session from fighting over the terminal's size. A
PTY has one size but can have several clients attached, and a resize was applied
whoever sent it — so a background window's `ResizeObserver`, or a tab of it
becoming visible again, reflowed the terminal you were actually reading. The
main process now tracks which client owns each PTY's size and drops a resize
from anyone else; a client takes ownership only when your attention genuinely
lands on that terminal — the session selected, the window focused, the tab made
visible — and never on a reconnect or a background layout reflow.
