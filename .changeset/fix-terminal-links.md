---
"simpleedit": patch
---

Fix clicking links in terminal sessions. The xterm.js WebLinksAddon default handler
used `window.open()` which is blocked by Electron's popup policy. Links now open in
the default browser via a new `app:open-external` IPC channel.
