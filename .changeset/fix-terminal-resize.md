---
"simpleedit": patch
---

Fix terminal output rendering in a narrow strip after tab switches. The ResizeObserver was firing on hidden containers (display:none), causing fitAddon to calculate 0 columns and corrupt the PTY.
