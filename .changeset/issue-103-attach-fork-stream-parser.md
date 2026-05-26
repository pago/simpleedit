---
"simpleedit": patch
---

Fork-into-worktree tabs now drive the worktree's Claude status indicator the same way regular Claude tabs do — the stream parser is attached at fork time so OSC-title status events (✳ idle / ⠂ braille spinner) flow into the sidebar badge. Fixes #103.
