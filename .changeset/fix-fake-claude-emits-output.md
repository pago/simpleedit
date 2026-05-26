---
"simpleedit": patch
---

The fake claude binary used by e2e tests now emits a startup line. Tests that wait on `pty:data` to discover the terminal id (e.g. agent-view-sticky-label) need at least one event from the PTY; without output, they timed out at 10s.
