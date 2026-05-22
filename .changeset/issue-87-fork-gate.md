---
"simpleedit": minor
---

Refs #87 (fork menu gate; execution to follow once session-id capture lands).

Wires the `SIMPLEEDIT_EXPERIMENTAL_FORK=1` environment variable through a new `app:experimental-fork` IPC so the agent tab context menu can conditionally surface a `Fork into worktree…` item. The item is hidden entirely when the gate is off and disabled-with-tooltip when on — execution is blocked on session-id capture (see #95 / task #10). A follow-up PR will enable the item once capture lands.

Stacked on #98.
