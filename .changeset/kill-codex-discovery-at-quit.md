---
"simpleedit": patch
---

Quitting no longer hangs while Codex model discovery is in flight. The `codex app-server` child spawned to list models is now killed on quit; previously its open stdio pipes could deadlock Electron's shutdown, leaving the app process alive indefinitely.
