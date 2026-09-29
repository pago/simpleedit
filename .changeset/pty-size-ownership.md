---
"simpleedit": patch
---

Groundwork for viewing one session from more than one place: the main process
now tracks which client owns each terminal's size, and applies a resize only
from that one.

Nothing changes for a single window today — a session's terminal has exactly
one viewer, so there is nothing to arbitrate. It matters once a second client
attaches to the same session, which **Remote access** now makes possible: your
phone and your desktop would otherwise each fit the terminal to their own
screen and reflow it out from under the other. Ownership follows your
attention — the session selected, the window focused, the tab made visible —
and never moves on a reconnect or a background layout reflow. The client that
is not sizing the terminal says so rather than rendering at a width the
terminal no longer uses.
