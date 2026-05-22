---
"simpleedit": minor
---

Refs #87 (PR2 of 3): wire up the "Close session" item in the agent tab context menu. Picking it calls the existing `closeTab` flow (which detaches any stream parser and kills the PTY). Works for both Claude and Agent View tabs.

Stacked on #93. Fork item remains a disabled placeholder until PR3.
